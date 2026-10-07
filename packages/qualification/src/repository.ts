/**
 * Reading qualification from the record, under the caller's row security (ADR 0038 decision 12).
 *
 * Every query runs as the bound reader. A record, its credits and its submissions are read only by
 * the person, their contact and its reviewers; anyone else gets `undefined`, as if there were no
 * such record. The two facts the evaluator needs about the PERSON rather than the reader — which
 * resources the person can read, and every credit the person holds — come from database functions
 * that answer only for a record the reader may already read (`org.qualification_resource_reach`,
 * `org.qualification_credits_for_record`).
 */

import type { Tx } from '@kf/database';
import {
  evaluateRecord,
  type CreditFacts,
  type RecordEvaluation,
  type RecordFacts,
  type RecordState,
  type RequirementInForce,
  type ResourceReach,
  type SubmissionFacts,
} from './evaluate.js';
import type { EvidenceMode, Part, RequirementDefinition } from './pack.js';

const iso = (value: Date | string): string => new Date(value).toISOString();

interface RecordRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  person_id: string;
  contact_person_id: string;
  scope_object_id: string | null;
  pack_id: string;
  pack_revision: number;
  state: RecordState;
}

async function recordRow(tx: Tx, recordId: string): Promise<RecordRow | undefined> {
  return tx.maybeOne<RecordRow>(
    `select /* qualification.record */ r.id, r.organization_id, r.person_id, r.contact_person_id,
            r.scope_object_id, r.pack_id, r.pack_revision, o.lifecycle_state as state
       from org.qualification_record r
       join core.object o on o.id = r.id
      where r.id = $1`,
    [recordId],
  );
}

/** A record's pinned composition, each requirement with its definition in force today. */
export async function requirementsInForce(
  tx: Tx,
  organizationId: string,
  packId: string,
  packRevision: number,
): Promise<RequirementInForce[]> {
  const rows = await tx.query<{
    requirement_key: string;
    requirement_revision: number;
    part: Part;
    revision: number | null;
    current_floor: number | null;
    definition: RequirementDefinition | null;
  }>(
    `select /* qualification.composition */ pr.requirement_key, pr.requirement_revision, pr.part,
            f.revision, f.current_floor, f.definition
       from org.qualification_pack_requirement pr
       left join lateral org.qualification_requirement_in_force(pr.organization_id,
                                                                pr.requirement_key) f on true
      where pr.organization_id = $1 and pr.pack_id = $2 and pr.pack_revision = $3
      order by pr.requirement_key`,
    [organizationId, packId, packRevision],
  );
  return rows
    .filter((row) => row.revision !== null && row.definition !== null)
    .map((row) => ({
      key: row.requirement_key,
      part: row.part,
      pinnedRevision: row.requirement_revision,
      revision: row.revision!,
      floor: row.current_floor ?? 1,
      definition: row.definition!,
    }));
}

/** Evaluate a record for the bound reader, or `undefined` if the reader may not read it. */
export async function loadRecordEvaluation(
  tx: Tx,
  recordId: string,
): Promise<RecordEvaluation | undefined> {
  const record = await recordRow(tx, recordId);
  if (record === undefined) return undefined;
  const pack = await tx.one<{ pack_key: string; title: string; closing: RecordFacts['closing'] }>(
    `select /* qualification.pack */ p.pack_key, pr.title, pr.closing
       from org.qualification_pack_revision pr
       join org.qualification_pack p on p.id = pr.pack_id
      where pr.pack_id = $1 and pr.revision = $2`,
    [record.pack_id, record.pack_revision],
  );
  const names = await tx.query<{ id: string; title: string }>(
    `select /* qualification.names */ o.id, o.title from core.object o
      where o.id = any($1::uuid[])`,
    [
      [
        record.contact_person_id,
        ...(record.scope_object_id === null ? [] : [record.scope_object_id]),
      ],
    ],
  );
  const nameOf = (id: string | null) =>
    id === null ? undefined : names.find((n) => n.id === id)?.title;
  const requirements = await requirementsInForce(
    tx,
    record.organization_id,
    record.pack_id,
    record.pack_revision,
  );
  const credits = (
    await tx.query<{
      id: string;
      record_id: string;
      requirement_key: string;
      requirement_revision: number;
      evidence_mode: EvidenceMode;
      evidence_object_id: string | null;
      prior_credit_id: string | null;
      credited_by: string;
      credited_at: Date;
      record_state: RecordState;
    }>('select * from org.qualification_credits_for_record($1)', [recordId])
  ).map((c): CreditFacts => ({
    id: c.id,
    recordId: c.record_id,
    recordState: c.record_state,
    key: c.requirement_key,
    revision: c.requirement_revision,
    mode: c.evidence_mode,
    evidenceObjectId: c.evidence_object_id,
    priorCreditId: c.prior_credit_id,
    creditedBy: c.credited_by,
    creditedAt: iso(c.credited_at),
  }));
  const submissions = (
    await tx.query<{
      id: string;
      requirement_key: string;
      evidence_object_id: string;
      submitted_at: Date;
      agent_client_id: string | null;
    }>(
      `select /* qualification.submissions */ s.id, s.requirement_key, s.evidence_object_id,
              s.submitted_at, s.agent_client_id
         from org.qualification_evidence_submission s
        where s.record_id = $1
          and not exists (select 1 from org.qualification_credit c where c.submission_id = s.id)
        order by s.submitted_at, s.id`,
      [recordId],
    )
  ).map((s): SubmissionFacts => ({
    id: s.id,
    key: s.requirement_key,
    evidenceObjectId: s.evidence_object_id,
    submittedAt: iso(s.submitted_at),
    agentClientId: s.agent_client_id,
  }));
  const reach = new Map<string, ResourceReach>(
    (
      await tx.query<{ resource_id: string; reach: ResourceReach }>(
        'select resource_id, reach from org.qualification_resource_reach($1)',
        [recordId],
      )
    ).map((row) => [row.resource_id, row.reach]),
  );
  const authorities = [...new Set(requirements.map((r) => r.definition.accepted_by))];
  const available = new Map<string, boolean>();
  for (const authority of authorities) {
    if (authority === 'self') {
      available.set(authority, true);
    } else if (authority === 'contact') {
      const live = await tx.one<{ live: boolean }>(
        'select org.qualification_person_is_live($1) as live',
        [record.contact_person_id],
      );
      available.set(authority, live.live);
    } else {
      const held = await tx.one<{ held: boolean }>(
        'select org.qualification_role_has_holder($1, $2, $3) as held',
        [record.organization_id, authority.slice('role:'.length), record.person_id],
      );
      available.set(authority, held.held);
    }
  }
  const contactName = nameOf(record.contact_person_id);
  const scopeTitle = nameOf(record.scope_object_id);
  return evaluateRecord({
    record: {
      id: record.id,
      personId: record.person_id,
      contactPersonId: record.contact_person_id,
      ...(contactName === undefined ? {} : { contactName }),
      scopeObjectId: record.scope_object_id,
      ...(scopeTitle === undefined ? {} : { scopeTitle }),
      state: record.state,
      packId: record.pack_id,
      packKey: pack.pack_key,
      packTitle: pack.title,
      packRevision: record.pack_revision,
      closing: pack.closing,
    },
    requirements,
    credits,
    submissions,
    organization: {
      resourceReach: reach,
      reviewerAvailable: (authority) => available.get(authority) ?? false,
    },
  });
}

/** The reader's own records that are still in force (assigned or qualified), oldest first. */
export async function ownRecords(
  tx: Tx,
  reader: { readonly actorId: string; readonly organizationId: string },
): Promise<{ id: string; state: RecordState }[]> {
  return tx.query<{ id: string; state: RecordState }>(
    `select /* qualification.own */ r.id, o.lifecycle_state as state
       from org.qualification_record r
       join core.object o on o.id = r.id
      where r.organization_id = $1 and r.person_id = $2
        and o.lifecycle_state in ('assigned', 'qualified')
      order by r.assigned_at, r.id`,
    [reader.organizationId, reader.actorId],
  );
}

export interface ReviewableRecord {
  readonly id: string;
  readonly personId: string;
  readonly personName: string | null;
  readonly state: RecordState;
  readonly packTitle: string;
  readonly packRevision: number;
  /** Whether the reader is this person's named contact. */
  readonly contact: boolean;
}

/** Records of OTHER people the reader may read: as their contact or as a reviewer of the pack. */
export async function reviewableRecords(
  tx: Tx,
  reader: { readonly actorId: string; readonly organizationId: string },
  limit = 25,
): Promise<ReviewableRecord[]> {
  const rows = await tx.query<{
    id: string;
    person_id: string;
    person_name: string | null;
    state: RecordState;
    title: string;
    pack_revision: number;
    contact_person_id: string;
  }>(
    `select /* qualification.reviewable */ r.id, r.person_id, p.title as person_name,
            o.lifecycle_state as state, pr.title, r.pack_revision, r.contact_person_id
       from org.qualification_record r
       join core.object o on o.id = r.id
       join org.qualification_pack_revision pr
         on pr.pack_id = r.pack_id and pr.revision = r.pack_revision
       left join core.object p on p.id = r.person_id
      where r.organization_id = $1 and r.person_id <> $2
        and o.lifecycle_state in ('assigned', 'qualified')
      order by r.assigned_at desc, r.id
      limit $3`,
    [reader.organizationId, reader.actorId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    personId: row.person_id,
    personName: row.person_name,
    state: row.state,
    packTitle: row.title,
    packRevision: row.pack_revision,
    contact: row.contact_person_id === reader.actorId,
  }));
}

export interface EvidenceToCredit {
  readonly submissionId: string;
  readonly recordId: string;
  readonly personId: string;
  readonly personName: string | null;
  readonly requirementKey: string;
  readonly outcome: string;
  readonly mode: EvidenceMode;
  readonly evidenceObjectId: string;
  readonly evidenceTitle: string | null;
  readonly evidenceVerified: boolean;
  readonly agentClientId: string | null;
  readonly submittedAt: string;
  readonly packTitle: string;
}

/**
 * Evidence submitted for a requirement the READER may credit and nobody has: the qualification
 * part of Needs you. A requirement the reader may not credit is not listed to them, whoever can
 * read the record; nor is the reader's own.
 */
export async function evidenceToCredit(
  tx: Tx,
  reader: { readonly actorId: string; readonly organizationId: string },
  limit = 25,
): Promise<{ items: EvidenceToCredit[]; total: number }> {
  const rows = await tx.query<{
    id: string;
    record_id: string;
    person_id: string;
    person_name: string | null;
    requirement_key: string;
    evidence_object_id: string;
    evidence_title: string | null;
    verified: boolean;
    agent_client_id: string | null;
    submitted_at: Date;
    contact_person_id: string;
    pack_title: string;
    accepted_by: string | null;
    outcome: string | null;
    evidence_mode: EvidenceMode | null;
  }>(
    `select /* qualification.to-credit */ s.id, s.record_id, s.person_id, p.title as person_name,
            s.requirement_key, s.evidence_object_id, e.title as evidence_title,
            exists (select 1 from core.object_verification v
                     where v.object_id = s.evidence_object_id
                       and v.basis = 'reviewed_individually') as verified,
            s.agent_client_id, s.submitted_at, s.contact_person_id, pr.title as pack_title,
            f.accepted_by, f.outcome, f.evidence_mode
       from org.qualification_evidence_submission s
       join core.object rec on rec.id = s.record_id
       join org.qualification_pack_revision pr
         on pr.pack_id = s.pack_id and pr.revision = s.pack_revision
       left join core.object p on p.id = s.person_id
       left join core.object e on e.id = s.evidence_object_id
       left join lateral org.qualification_requirement_in_force(s.organization_id,
                                                                s.requirement_key) f on true
      where s.organization_id = $1
        and s.person_id <> $2
        and rec.lifecycle_state in ('assigned', 'qualified')
        and not exists (select 1 from org.qualification_credit c where c.submission_id = s.id)
      order by s.submitted_at, s.id`,
    [reader.organizationId, reader.actorId],
  );
  const mine: EvidenceToCredit[] = [];
  const roleHeld = new Map<string, boolean>();
  for (const row of rows) {
    if (row.accepted_by === null || row.accepted_by === 'self') continue;
    let may: boolean;
    if (row.accepted_by === 'contact') {
      may = row.contact_person_id === reader.actorId;
    } else {
      const authority = row.accepted_by.slice('role:'.length);
      if (!roleHeld.has(authority)) {
        const held = await tx.one<{ held: boolean }>(
          'select org.qualification_holds_role($1, $2, $3) as held',
          [reader.actorId, reader.organizationId, authority],
        );
        roleHeld.set(authority, held.held);
      }
      may = roleHeld.get(authority) === true;
    }
    if (!may) continue;
    mine.push({
      submissionId: row.id,
      recordId: row.record_id,
      personId: row.person_id,
      personName: row.person_name,
      requirementKey: row.requirement_key,
      outcome: row.outcome ?? '',
      mode: row.evidence_mode ?? 'demonstrate',
      evidenceObjectId: row.evidence_object_id,
      evidenceTitle: row.evidence_title,
      evidenceVerified: row.verified,
      agentClientId: row.agent_client_id,
      submittedAt: iso(row.submitted_at),
      packTitle: row.pack_title,
    });
  }
  return { items: mine.slice(0, limit), total: mine.length };
}
