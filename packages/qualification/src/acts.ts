/**
 * The qualification acts (ADR 0038 decisions 3, 6, 7, 8; ontology/action-types.yaml).
 *
 * Each is an ordinary typed act through the dispatcher: authority resolved, the act recorded,
 * then its typed writes. The database decides every rule that matters
 * (20261007400000): who may credit, at which mode, against which evidence, whether a record may
 * close, whether an act needs a qualification. What is here is the shape of each payload, the
 * validation of a pack document (which needs the pack's parts and the organization's references),
 * and refusals that name the field a caller got wrong.
 *
 * Typed rows are written in EFFECTS, after the act is recorded, never in materializers: the
 * database binds each row to the act that writes it (`core.current_action_type()`), which exists
 * only once the dispatcher has written `core.action`. A materializer creates the envelope only.
 */

import {
  ActionRejected,
  type ActionEffect,
  type ActionMaterializer,
  type ActionReceiptReader,
  type ObjectRow,
  type PreconditionCheck,
} from '@kf/actions';
import type { JsonValue } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import { createControlledObject } from '@kf/record-atoms';
import {
  describeProblems,
  packDigest,
  validatePackDocument,
  type ComposedRequirement,
  type PackDocument,
  type PackProblem,
  type PartRef,
  type RequirementDefinition,
  type ResolvedPart,
} from './pack.js';

export const QUALIFICATION_ACTION_IDS = [
  'draft_qualification_pack',
  'approve_qualification_pack',
  'supersede_qualification_pack',
  'retire_qualification_pack',
  'assign_qualification',
  'submit_qualification_evidence',
  'credit_qualification_evidence',
  'accept_qualification',
  'withdraw_qualification',
  'supersede_qualification',
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function refuse(message: string, detail: Record<string, unknown> = {}): never {
  throw new ActionRejected('precondition_failed', message, detail);
}

function payloadOf(request: { readonly payload?: Readonly<Record<string, JsonValue>> }) {
  return request.payload ?? {};
}

function uuidField(
  payload: Readonly<Record<string, JsonValue>>,
  key: string,
  act: string,
  optional = false,
): string | null {
  const value = payload[key];
  if (value === undefined || value === null) {
    if (optional) return null;
    refuse(`${act} needs ${key} in its payload`, { field: key });
  }
  if (typeof value !== 'string' || !UUID.test(value)) refuse(`${key} is a uuid`, { field: key });
  return value.toLowerCase();
}

function stringField(
  payload: Readonly<Record<string, JsonValue>>,
  key: string,
  act: string,
): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.trim() === '') {
    refuse(`${act} needs ${key} in its payload`, { field: key });
  }
  return value.trim();
}

function reasonOf(request: { readonly reason?: string }, act: string, why: string): string {
  const reason = request.reason?.trim() ?? '';
  if (reason.length < 8) refuse(`${act} needs a reason: ${why}`, { field: 'reason' });
  return reason;
}

/** A database refusal the caller can act on keeps its rule; anything else stays a fault. */
function asRefusal(error: unknown, detail: Record<string, unknown> = {}): never {
  const e = error as { code?: string; message?: string };
  const rule = typeof e.message === 'string' ? /^(KF-[A-Z]+-\d+):/.exec(e.message) : null;
  if (e.code === '23514' && rule !== null) {
    throw new ActionRejected('precondition_failed', e.message!, {
      ...detail,
      rule: rule[1],
      enforcedBy: 'database',
    });
  }
  if (e.code === '23505') refuse('that is already recorded', detail);
  if (e.code === '23503') refuse(`a reference does not exist: ${e.message ?? ''}`, detail);
  throw error;
}

function target(objects: readonly ObjectRow[], type: string, act: string): ObjectRow {
  const found = objects.filter((o) => o.object_type === type);
  if (found.length !== 1) refuse(`${act} targets exactly one ${type}`, { objectType: type });
  return found[0]!;
}

// ── Pack documents ───────────────────────────────────────────────────────────────────────────

/** Every part reference a raw document names, before it is validated. */
function partRefsOf(raw: unknown): PartRef[] {
  if (typeof raw !== 'object' || raw === null) return [];
  const parts = (raw as Record<string, unknown>)['parts'];
  if (typeof parts !== 'object' || parts === null) return [];
  const refs: PartRef[] = [];
  for (const list of Object.values(parts as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const ref of list) {
      const r = ref as Record<string, unknown> | null;
      if (r !== null && typeof r['pack'] === 'string' && typeof r['revision'] === 'number') {
        refs.push({ pack: r['pack'], revision: r['revision'] });
      }
    }
  }
  return refs;
}

/** What the organization holds about each part a document names. */
async function resolveParts(
  tx: Tx,
  organizationId: string,
  refs: readonly PartRef[],
): Promise<Map<string, ResolvedPart>> {
  const resolved = new Map<string, ResolvedPart>();
  for (const ref of refs) {
    const id = `${ref.pack}@${String(ref.revision)}`;
    if (resolved.has(id)) continue;
    const pack = await tx.maybeOne<{
      pack_id: string;
      approved: boolean;
      composes: boolean;
    }>(
      `select /* qualification.part */ r.pack_id,
              (r.approved_at is not null and o.lifecycle_state = 'approved') as approved,
              exists (select 1 from jsonb_each(coalesce(r.document -> 'parts', '{}'::jsonb)) e
                       where jsonb_typeof(e.value) = 'array' and jsonb_array_length(e.value) > 0)
                as composes
         from org.qualification_pack p
         join org.qualification_pack_revision r on r.pack_id = p.id
         join core.object o on o.id = p.id
        where p.organization_id = $1 and p.pack_key = $2 and r.revision = $3`,
      [organizationId, ref.pack, ref.revision],
    );
    if (pack === undefined) continue;
    const rows = await tx.query<{
      requirement_key: string;
      requirement_revision: number;
      part: ComposedRequirement['part'];
      via_pack: string | null;
      definition: RequirementDefinition;
      definition_digest: string;
    }>(
      `select pr.requirement_key, pr.requirement_revision, pr.part, pr.via_pack,
              rr.definition, rr.definition_digest
         from org.qualification_pack_requirement pr
         join org.qualification_requirement_revision rr
           on rr.organization_id = pr.organization_id
          and rr.requirement_key = pr.requirement_key
          and rr.revision = pr.requirement_revision
        where pr.pack_id = $1 and pr.pack_revision = $2
        order by pr.requirement_key`,
      [pack.pack_id, ref.revision],
    );
    resolved.set(id, {
      key: ref.pack,
      revision: ref.revision,
      approved: pack.approved,
      composesParts: pack.composes,
      requirements: rows.map((row) => ({
        key: row.requirement_key,
        revision: row.requirement_revision,
        part: row.part,
        ...(row.via_pack === null ? {} : { via: { pack: row.via_pack, revision: 0 } }),
        definition: row.definition,
        digest: row.definition_digest,
      })),
    });
  }
  return resolved;
}

/**
 * What only the record can say about a document: do its roles, acts, scopes, equivalents and
 * resources exist, and can the approver read every mandatory resource (inaccessible to the person
 * approving it means inaccessible to the organization's own authority). Run under the bound
 * approver's row security.
 */
export async function checkPackReferences(
  tx: Tx,
  organizationId: string,
  document: PackDocument,
  composition: readonly ComposedRequirement[],
): Promise<PackProblem[]> {
  const problems: PackProblem[] = [];
  const roles = new Set<string>();
  const role = (authority: string | undefined) => {
    if (authority?.startsWith('role:') === true) roles.add(authority.slice('role:'.length));
  };
  role(document.owner);
  role(document.acceptor);
  for (const r of composition) role(r.definition.accepted_by);
  if (roles.size > 0) {
    const known = new Set(
      (
        await tx.query<{ id: string }>('select id from org.role where id = any($1::text[])', [
          [...roles],
        ])
      ).map((row) => row.id),
    );
    for (const missing of [...roles].filter((id) => !known.has(id)).sort()) {
      problems.push({
        code: 'missing_owner',
        path: `role:${missing}`,
        message: `role ${missing} does not exist, so nobody can hold the authority it names`,
      });
    }
  }
  const gates = [...new Set(composition.flatMap((r) => r.definition.gates ?? []))];
  if (gates.length > 0) {
    const declared = new Map(
      (
        await tx.query<{ id: string; requires_qualification: boolean }>(
          'select id, requires_qualification from registry.action_type where id = any($1::text[])',
          [gates],
        )
      ).map((row) => [row.id, row.requires_qualification]),
    );
    for (const gate of gates.sort()) {
      if (!declared.has(gate)) {
        problems.push({ code: 'dead_reference', path: `gates:${gate}`, message: `no act ${gate}` });
      } else if (declared.get(gate) !== true) {
        problems.push({
          code: 'ungated_action',
          path: `gates:${gate}`,
          message:
            `${gate} does not declare requires_qualification, so the database would never check ` +
            'it; a requirement gates only an act that declares it (ADR 0038 decision 8)',
        });
      }
    }
  }
  const keys = new Set(composition.map((r) => r.key));
  const equivalents = [
    ...new Set(composition.flatMap((r) => r.definition.equivalent_to ?? [])),
  ].filter((k) => !keys.has(k));
  if (equivalents.length > 0) {
    const known = new Set(
      (
        await tx.query<{ requirement_key: string }>(
          `select distinct requirement_key from org.qualification_requirement_revision
            where organization_id = $1 and requirement_key = any($2::text[])`,
          [organizationId, equivalents],
        )
      ).map((row) => row.requirement_key),
    );
    for (const key of equivalents.filter((k) => !known.has(k)).sort()) {
      problems.push({
        code: 'dead_reference',
        path: `equivalent_to:${key}`,
        message: `no requirement ${key} in this organization to be equivalent to`,
      });
    }
  }
  // Scopes and resources of this pack's OWN requirements: a part's were checked when it was
  // approved, and are referenced by revision, not re-read.
  const own = composition.filter((r) => r.via === undefined);
  const objects = new Set<string>();
  for (const r of own) {
    const scope = r.definition.scope;
    if (scope !== undefined && scope !== 'organization') objects.add(scope.object);
    for (const resource of r.definition.resources ?? []) objects.add(resource.id);
  }
  const visible = new Map<
    string,
    { object_type: string; row_version: string; revisions: string[] }
  >();
  if (objects.size > 0) {
    const rows = await tx.query<{
      id: string;
      object_type: string;
      row_version: string;
      revisions: string[] | null;
    }>(
      `select /* qualification.resources */ o.id, o.object_type, o.row_version::text,
              array_remove(array[cd.revision]
                || coalesce((select array_agg(v.version_no::text) || array_agg(v.revision_label)
                               from content.artifact_version v where v.artifact_id = o.id),
                            '{}'::text[]), null) as revisions
         from core.object o
         left join quality.controlled_document cd on cd.id = o.id
        where o.id = any($1::uuid[]) and o.organization_id = $2`,
      [[...objects], organizationId],
    );
    for (const row of rows) {
      visible.set(row.id, {
        object_type: row.object_type,
        row_version: row.row_version,
        revisions: row.revisions ?? [],
      });
    }
  }
  for (const r of own) {
    const scope = r.definition.scope;
    if (scope !== undefined && scope !== 'organization' && !visible.has(scope.object)) {
      problems.push({
        code: 'dead_reference',
        path: `requirement ${r.key}.scope`,
        message: `scope ${scope.object} is not a record in this organization`,
      });
    }
    for (const resource of r.definition.resources ?? []) {
      const found = visible.get(resource.id);
      if (found === undefined) {
        problems.push({
          code: r.definition.mandatory ? 'inaccessible_resource' : 'dead_reference',
          path: `requirement ${r.key}.resources`,
          message: r.definition.mandatory
            ? `mandatory resource ${resource.id} does not exist or the approver cannot read it; a ` +
              'mandatory requirement nobody can meet would fail people for the organization’s gap'
            : `resource ${resource.id} does not exist or the approver cannot read it`,
        });
        continue;
      }
      const revisions = found.revisions.length > 0 ? found.revisions : [found.row_version];
      if (!revisions.includes(resource.revision)) {
        problems.push({
          code: 'dead_reference',
          path: `requirement ${r.key}.resources`,
          message:
            `resource ${resource.id} has no revision ${resource.revision} ` +
            `(it has ${revisions.join(', ')}); a resource is referenced by identifier and revision`,
        });
      }
    }
  }
  return problems;
}

/** Validate a raw document fully: shape, composition with its parts, and its references. */
export async function validatePackInRecord(
  tx: Tx,
  organizationId: string,
  raw: unknown,
): Promise<{ document: PackDocument; composition: readonly ComposedRequirement[] }> {
  const parts = await resolveParts(tx, organizationId, partRefsOf(raw));
  const validation = validatePackDocument(raw, (ref) =>
    parts.get(`${ref.pack}@${String(ref.revision)}`),
  );
  if (validation.problems.length > 0 || validation.document === undefined) {
    refuse(`the pack document is refused: ${describeProblems(validation.problems)}`, {
      rule: 'KF-QUAL-050',
      problems: validation.problems.map((p) => ({ ...p })),
    });
  }
  const references = await checkPackReferences(
    tx,
    organizationId,
    validation.document,
    validation.composition,
  );
  if (references.length > 0) {
    refuse(`the pack document is refused: ${describeProblems(references)}`, {
      rule: 'KF-QUAL-050',
      problems: references.map((p) => ({ ...p })),
    });
  }
  return { document: validation.document, composition: validation.composition };
}

/** Write a revision's document, its new requirement revisions and its composition. */
async function writeRevision(
  tx: Tx,
  organizationId: string,
  packId: string,
  document: PackDocument,
  composition: readonly ComposedRequirement[],
  ctx: { readonly actionId: string },
  drafter: string,
): Promise<void> {
  const authority = (value: string | undefined) =>
    value === undefined ? null : value.slice('role:'.length);
  try {
    await tx.query(
      `insert into org.qualification_pack_revision
         (pack_id, revision, organization_id, title, document, document_digest, owner_role, closing,
          acceptor_role, drafted_by, drafted_by_action)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)`,
      [
        packId,
        document.revision,
        organizationId,
        document.title,
        JSON.stringify(document),
        packDigest(document),
        authority(document.owner),
        document.closing,
        authority(document.acceptor),
        drafter,
        ctx.actionId,
      ],
    );
    for (const requirement of composition.filter((r) => r.via === undefined)) {
      const existing = await tx.maybeOne<{ definition_digest: string }>(
        `select definition_digest from org.qualification_requirement_revision
          where organization_id = $1 and requirement_key = $2 and revision = $3`,
        [organizationId, requirement.key, requirement.revision],
      );
      if (existing !== undefined) {
        if (existing.definition_digest !== requirement.digest) {
          refuse(
            `requirement ${requirement.key} revision ${String(requirement.revision)} is already ` +
              'defined differently; a changed requirement is a new revision (KF-QUAL-003)',
            { rule: 'KF-QUAL-003', requirement: requirement.key },
          );
        }
        continue;
      }
      const d = requirement.definition;
      const scope = d.scope === undefined || d.scope === 'organization' ? null : d.scope.object;
      await tx.query(
        `insert into org.qualification_requirement_revision
           (organization_id, requirement_key, revision, definition, definition_digest, stage,
            outcome, evidence_mode, accepted_by, mandatory, consequence, behavioural_impact,
            scope_object_id, gates, introduced_by_pack, introduced_in_revision)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::text[], $15, $16)`,
        [
          organizationId,
          requirement.key,
          requirement.revision,
          JSON.stringify(d),
          requirement.digest,
          d.stage,
          d.outcome,
          d.evidence_mode,
          d.accepted_by,
          d.mandatory,
          d.consequence === undefined ? null : `${d.consequence.kind}: ${d.consequence.statement}`,
          requirement.revision === 1 ? true : d.behavioural_impact === true,
          scope,
          [...(d.gates ?? [])],
          packId,
          document.revision,
        ],
      );
    }
    const viaIds = new Map<string, string>();
    for (const requirement of composition) {
      let viaPack: string | null = null;
      if (requirement.via !== undefined) {
        const id = `${requirement.via.pack}`;
        if (!viaIds.has(id)) {
          const row = await tx.one<{ id: string }>(
            'select id from org.qualification_pack where organization_id = $1 and pack_key = $2',
            [organizationId, requirement.via.pack],
          );
          viaIds.set(id, row.id);
        }
        viaPack = viaIds.get(id)!;
      }
      await tx.query(
        `insert into org.qualification_pack_requirement
           (pack_id, pack_revision, organization_id, requirement_key, requirement_revision, part,
            via_pack, via_revision)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          packId,
          document.revision,
          organizationId,
          requirement.key,
          requirement.revision,
          requirement.part,
          viaPack,
          requirement.via?.revision ?? null,
        ],
      );
    }
  } catch (error: unknown) {
    if (error instanceof ActionRejected) throw error;
    asRefusal(error, { packId });
  }
}

/** `draft_qualification_pack`: the envelope; the document is validated before anything is made. */
export const draftQualificationPack: ActionMaterializer = async (tx, request) => {
  if (request.targetIds.length > 0) return [];
  const raw = payloadOf(request)['document'];
  const { document } = await validatePackInRecord(tx, request.organizationId, raw);
  if (document.revision !== 1) {
    refuse('a new pack starts at revision 1; a later revision is supersede_qualification_pack', {
      field: 'document.revision',
    });
  }
  const taken = await tx.maybeOne<{ id: string }>(
    'select id from org.qualification_pack where organization_id = $1 and pack_key = $2',
    [request.organizationId, document.key],
  );
  if (taken !== undefined) {
    refuse(`pack ${document.key} exists; revise it with supersede_qualification_pack`, {
      packId: taken.id,
    });
  }
  return [
    await createControlledObject(tx, {
      objectType: 'qualification_pack',
      authorityDomain: 'organization',
      lifecycleState: 'draft',
      title: document.title,
      organizationId: request.organizationId,
      createdBy: request.actorId,
    }),
  ];
};

export const draftQualificationPackEffect: ActionEffect = async (tx, request, objects, ctx) => {
  const pack = target(objects, 'qualification_pack', 'draft_qualification_pack');
  const { document, composition } = await validatePackInRecord(
    tx,
    request.organizationId,
    payloadOf(request)['document'],
  );
  try {
    await tx.query(
      'insert into org.qualification_pack (id, organization_id, pack_key) values ($1, $2, $3)',
      [pack.id, request.organizationId, document.key],
    );
  } catch (error: unknown) {
    asRefusal(error, { packId: pack.id });
  }
  await writeRevision(
    tx,
    request.organizationId,
    pack.id,
    document,
    composition,
    ctx,
    request.actorId,
  );
};

/** The revision a pack's approval or supersession works from. */
async function latestRevision(
  tx: Tx,
  packId: string,
): Promise<{ revision: number; approved: boolean; key: string; document: unknown }> {
  const row = await tx.maybeOne<{
    revision: number;
    approved: boolean;
    pack_key: string;
    document: unknown;
  }>(
    `select r.revision, r.approved_at is not null as approved, p.pack_key, r.document
       from org.qualification_pack_revision r
       join org.qualification_pack p on p.id = r.pack_id
      where r.pack_id = $1
      order by r.revision desc limit 1`,
    [packId],
  );
  if (row === undefined) refuse(`pack ${packId} has no revision`, { packId });
  return {
    revision: row.revision,
    approved: row.approved,
    key: row.pack_key,
    document: row.document,
  };
}

/** `approve_qualification_pack`: the draft revision, validated again against today's record. */
export const approvePackPrecondition: PreconditionCheck = async (tx, request, objects) => {
  const pack = target(objects, 'qualification_pack', 'approve_qualification_pack');
  const latest = await latestRevision(tx, pack.id);
  if (latest.approved) refuse('the latest revision is already approved', { packId: pack.id });
  await validatePackInRecord(tx, request.organizationId, latest.document);
};

export const approvePackEffect: ActionEffect = async (tx, _request, objects) => {
  const pack = target(objects, 'qualification_pack', 'approve_qualification_pack');
  const latest = await latestRevision(tx, pack.id);
  try {
    // The database stamps who, which act and when (qualification_pack_bounded).
    await tx.query(
      `update org.qualification_pack_revision
          set approved_by = core.current_actor_or_null(),
              approved_by_action = core.current_action_id(),
              approved_at = now()
        where pack_id = $1 and revision = $2 and approved_at is null`,
      [pack.id, latest.revision],
    );
  } catch (error: unknown) {
    asRefusal(error, { packId: pack.id });
  }
};

/**
 * `supersede_qualification_pack`: a new revision of an approved pack, approved in the same act.
 * Every requirement whose revision moves past the one in force declares its behavioural impact,
 * which is what decides whether anybody gains a gap (RQ-259).
 */
export const supersedePackPrecondition: PreconditionCheck = async (tx, request, objects) => {
  const pack = target(objects, 'qualification_pack', 'supersede_qualification_pack');
  if (pack.lifecycle_state !== 'approved') {
    refuse('only an approved pack is superseded; approve the draft first', { packId: pack.id });
  }
  const latest = await latestRevision(tx, pack.id);
  const { document } = await validatePackInRecord(
    tx,
    request.organizationId,
    payloadOf(request)['document'],
  );
  if (document.key !== latest.key) {
    refuse(`the document is pack ${document.key}, and this is pack ${latest.key}`, {
      field: 'document.key',
    });
  }
  if (document.revision !== latest.revision + 1) {
    refuse(`the next revision of ${latest.key} is ${String(latest.revision + 1)}`, {
      field: 'document.revision',
    });
  }
  reasonOf(request, 'supersede_qualification_pack', 'what changed, and why');
};

export const supersedePackEffect: ActionEffect = async (tx, request, objects, ctx) => {
  const pack = target(objects, 'qualification_pack', 'supersede_qualification_pack');
  const { document, composition } = await validatePackInRecord(
    tx,
    request.organizationId,
    payloadOf(request)['document'],
  );
  await writeRevision(
    tx,
    request.organizationId,
    pack.id,
    document,
    composition,
    ctx,
    request.actorId,
  );
};

export const retirePackPrecondition: PreconditionCheck = async (_tx, request) => {
  reasonOf(request, 'retire_qualification_pack', 'why the organization stops assigning it');
};

// ── Records ─────────────────────────────────────────────────────────────────────────────────

/** `assign_qualification`: the record's envelope; the typed row follows in the effect. */
export const assignQualification: ActionMaterializer = async (tx, request) => {
  if (request.targetIds.length > 0) return [];
  const payload = payloadOf(request);
  const packId = uuidField(payload, 'pack_id', 'assign_qualification')!;
  uuidField(payload, 'person_id', 'assign_qualification');
  uuidField(payload, 'contact_person_id', 'assign_qualification');
  const scopeId = uuidField(payload, 'scope_object_id', 'assign_qualification', true);
  const pack = await tx.maybeOne<{ title: string; state: string }>(
    `select o.title, o.lifecycle_state as state from core.object o
      where o.id = $1 and o.object_type = 'qualification_pack'`,
    [packId],
  );
  if (pack === undefined) refuse(`no qualification pack ${packId}`, { field: 'pack_id' });
  if (pack.state !== 'approved') {
    refuse('a person is assigned only an approved pack (KF-QUAL-030)', { rule: 'KF-QUAL-030' });
  }
  const scope =
    scopeId === null
      ? undefined
      : await tx.maybeOne<{ title: string }>('select title from core.object where id = $1', [
          scopeId,
        ]);
  if (scopeId !== null && scope === undefined) {
    refuse(`scope ${scopeId} is not a record this person can see`, { field: 'scope_object_id' });
  }
  // The envelope says the scope and nothing about the person: who is qualifying is in the typed
  // row, which only the person, their contact and its reviewers read (decision 12).
  return [
    await createControlledObject(tx, {
      objectType: 'qualification_record',
      authorityDomain: 'organization',
      lifecycleState: 'assigned',
      title:
        scope === undefined
          ? `Qualification: ${pack.title}`
          : `Qualification: ${pack.title} — ${scope.title}`,
      organizationId: request.organizationId,
      createdBy: request.actorId,
    }),
  ];
};

export const assignQualificationEffect: ActionEffect = async (tx, request, objects, ctx) => {
  const record = target(objects, 'qualification_record', 'assign_qualification');
  const payload = payloadOf(request);
  try {
    await tx.query(
      `insert into org.qualification_record
         (id, organization_id, person_id, scope_object_id, pack_id, pack_revision,
          contact_person_id, assigned_by, assigned_by_action)
       values ($1, $2, $3, $4, $5, 1, $6, $7, $8)`,
      [
        record.id,
        request.organizationId,
        uuidField(payload, 'person_id', 'assign_qualification'),
        uuidField(payload, 'scope_object_id', 'assign_qualification', true),
        uuidField(payload, 'pack_id', 'assign_qualification'),
        uuidField(payload, 'contact_person_id', 'assign_qualification'),
        request.actorId,
        ctx.actionId,
      ],
    );
  } catch (error: unknown) {
    asRefusal(error, { recordId: record.id });
  }
};

/** `submit_qualification_evidence`: the person names a record as evidence; credits nothing. */
export const submitEvidenceEffect: ActionEffect = async (tx, request, objects, ctx) => {
  const record = target(objects, 'qualification_record', 'submit_qualification_evidence');
  const payload = payloadOf(request);
  const note = payload['note'];
  try {
    await tx.query(
      `insert into org.qualification_evidence_submission
         (organization_id, record_id, person_id, contact_person_id, pack_id, pack_revision,
          requirement_key, evidence_object_id, note, submitted_by_action)
       select r.organization_id, r.id, r.person_id, r.contact_person_id, r.pack_id,
              r.pack_revision, $2, $3, $4, $5
         from org.qualification_record r where r.id = $1`,
      [
        record.id,
        stringField(payload, 'requirement_key', 'submit_qualification_evidence'),
        uuidField(payload, 'evidence_object_id', 'submit_qualification_evidence'),
        typeof note === 'string' && note.trim() !== '' ? note.trim().slice(0, 2000) : null,
        ctx.actionId,
      ],
    );
  } catch (error: unknown) {
    asRefusal(error, { recordId: record.id });
  }
  const written = await tx.maybeOne<{ id: string }>(
    'select id from org.qualification_evidence_submission where submitted_by_action = $1',
    [ctx.actionId],
  );
  if (written === undefined) {
    refuse('only the record’s own person (or their agent) submits evidence for it (KF-QUAL-031)', {
      rule: 'KF-QUAL-031',
    });
  }
};

interface CreditInput {
  readonly requirementKey: string;
  readonly evidenceObjectId: string | null;
  readonly priorCreditId: string | null;
  readonly submissionId: string | null;
}

function creditsOf(
  request: { readonly payload?: Readonly<Record<string, JsonValue>> },
  act: string,
) {
  const raw = payloadOf(request)['credits'];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) refuse(`${act}: credits is a list`, { field: 'credits' });
  return raw.map((entry, i): CreditInput => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      refuse(`${act}: credits[${String(i)}] is an object`, { field: `credits[${String(i)}]` });
    }
    const e = entry as Record<string, JsonValue>;
    const submissionId = uuidField(e, 'submission_id', act, true);
    const evidenceObjectId = uuidField(e, 'evidence_object_id', act, true);
    const priorCreditId = uuidField(e, 'prior_credit_id', act, true);
    const key = e['requirement_key'];
    if (submissionId === null && (typeof key !== 'string' || key === '')) {
      refuse(`${act}: credits[${String(i)}] names a requirement_key or a submission_id`, {
        field: `credits[${String(i)}]`,
      });
    }
    if (submissionId === null && (evidenceObjectId === null) === (priorCreditId === null)) {
      refuse(
        `${act}: credits[${String(i)}] names exactly one of evidence_object_id or prior_credit_id`,
        { field: `credits[${String(i)}]` },
      );
    }
    return {
      requirementKey: typeof key === 'string' ? key : '',
      evidenceObjectId,
      priorCreditId,
      submissionId,
    };
  });
}

/**
 * The credits an act carries, written after the work they name is accepted. Accepting the work
 * IS the reviewer's individual review of it (`core.object_verification`, reviewed individually,
 * by this act), so the one gesture accepts the work and credits what it evidences (RQ-257). One
 * act accepts at most one piece of unaccepted work: a person reviews one thing at a time.
 */
async function writeCredits(
  tx: Tx,
  request: Parameters<ActionEffect>[1],
  recordId: string,
  act: string,
  ctx: { readonly actionId: string },
): Promise<void> {
  const credits = creditsOf(request, act);
  const resolved = [];
  for (const credit of credits) {
    if (credit.submissionId === null) {
      resolved.push(credit);
      continue;
    }
    const submission = await tx.maybeOne<{
      requirement_key: string;
      evidence_object_id: string;
      record_id: string;
    }>(
      `select requirement_key, evidence_object_id, record_id
         from org.qualification_evidence_submission where id = $1`,
      [credit.submissionId],
    );
    if (submission === undefined || submission.record_id !== recordId) {
      refuse(`submission ${credit.submissionId} is not one for this record`, {
        submissionId: credit.submissionId,
      });
    }
    resolved.push({
      ...credit,
      requirementKey: submission.requirement_key,
      evidenceObjectId: submission.evidence_object_id,
    });
  }
  const acceptWork = payloadOf(request)['accept_work'] !== false;
  const unaccepted = new Set<string>();
  for (const credit of resolved) {
    if (credit.evidenceObjectId === null) continue;
    const mode = await tx.maybeOne<{ evidence_mode: string }>(
      'select evidence_mode from org.qualification_requirement_in_force($1, $2)',
      [request.organizationId, credit.requirementKey],
    );
    if (mode?.evidence_mode === 'acknowledge') continue;
    const verified = await tx.maybeOne<{ basis: string }>(
      'select basis from core.object_verification where object_id = $1',
      [credit.evidenceObjectId],
    );
    if (verified === undefined) unaccepted.add(credit.evidenceObjectId);
  }
  if (unaccepted.size > 0) {
    if (!acceptWork) {
      refuse(`${act}: the evidence is not accepted work, and accept_work is false`, {
        evidence: [...unaccepted],
      });
    }
    if (unaccepted.size > 1) {
      refuse(
        `${act} accepts one piece of work at a time; ${String(unaccepted.size)} unaccepted ` +
          'records are named. Accept the others first, or credit them separately',
        { evidence: [...unaccepted] },
      );
    }
    const [work] = [...unaccepted];
    const pace = await tx.one<{ refusal: string | null }>(
      'select core.individual_review_refusal($1) as refusal',
      [request.actorId],
    );
    if (pace.refusal !== null) refuse(pace.refusal, { evidence: work });
    try {
      await tx.query(
        `insert into core.object_verification (object_id, verified_by, basis, recorded_by_action)
         values ($1, $2, 'reviewed_individually', $3)`,
        [work, request.actorId, ctx.actionId],
      );
    } catch (error: unknown) {
      const e = error as { code?: string };
      if (e.code === '42501') {
        refuse(
          'a reviewer does not accept work they made (KF-SAS-RQ-047, RQ-230); the work must be ' +
            'accepted by someone other than its author',
          { rule: 'KF-QUAL-015', evidence: work },
        );
      }
      asRefusal(error, { evidence: work });
    }
  }
  for (const credit of resolved) {
    let written: readonly unknown[] = [];
    try {
      // The record's person, contact and pack, the revision in force and its mode are read here
      // and set again by the database (qualification_credit_bounded), which is the authority:
      // the caller names none of them.
      written = await tx.query(
        `insert into org.qualification_credit
           (organization_id, record_id, person_id, contact_person_id, pack_id, pack_revision,
            requirement_key, requirement_revision, evidence_mode, evidence_object_id,
            prior_credit_id, submission_id, credited_by, credited_by_action)
         select r.organization_id, r.id, r.person_id, r.contact_person_id, r.pack_id,
                r.pack_revision, $2, coalesce(f.revision, 1), coalesce(f.evidence_mode, 'demonstrate'),
                $3, $4, $5, $6, $7
           from org.qualification_record r
           left join lateral org.qualification_requirement_in_force(r.organization_id, $2) f on true
          where r.id = $1
         returning id`,
        [
          recordId,
          credit.requirementKey,
          credit.evidenceObjectId,
          credit.priorCreditId,
          credit.submissionId,
          request.actorId,
          ctx.actionId,
        ],
      );
    } catch (error: unknown) {
      asRefusal(error, { requirement: credit.requirementKey });
    }
    if (written.length === 0) {
      refuse(`KF-QUAL-012: qualification record ${recordId} is not one this person may credit`, {
        rule: 'KF-QUAL-012',
        recordId,
      });
    }
  }
}

export const creditEvidenceEffect: ActionEffect = async (tx, request, objects, ctx) => {
  const record = target(objects, 'qualification_record', 'credit_qualification_evidence');
  if (creditsOf(request, 'credit_qualification_evidence').length === 0) {
    refuse('credit_qualification_evidence credits at least one requirement', { field: 'credits' });
  }
  await writeCredits(tx, request, record.id, 'credit_qualification_evidence', ctx);
};

/**
 * `accept_qualification`: the record closes. Carries the last credits itself, so the reviewer who
 * accepts the last piece of work closes the record in the same act (RQ-257). The database refuses
 * at commit if any mandatory requirement still lacks a current credit, naming it.
 */
export const acceptQualificationEffect: ActionEffect = async (tx, request, objects, ctx) => {
  const record = target(objects, 'qualification_record', 'accept_qualification');
  await writeCredits(tx, request, record.id, 'accept_qualification', ctx);
};

export const withdrawPrecondition: PreconditionCheck = async (_tx, request, objects) => {
  target(objects, 'qualification_record', 'withdraw_qualification');
  reasonOf(
    request,
    'withdraw_qualification',
    'a withdrawal is recorded as what it is, never as missing evidence',
  );
};

export const supersedeRecordPrecondition: PreconditionCheck = async (tx, request, objects) => {
  const record = target(objects, 'qualification_record', 'supersede_qualification');
  reasonOf(request, 'supersede_qualification', 'what the newer record is for');
  const by = uuidField(payloadOf(request), 'superseded_by', 'supersede_qualification')!;
  if (by === record.id) refuse('a record does not supersede itself', { field: 'superseded_by' });
  const newer = await tx.maybeOne<{ object_type: string; lifecycle_state: string }>(
    'select object_type, lifecycle_state from core.object where id = $1',
    [by],
  );
  if (
    newer === undefined ||
    newer.object_type !== 'qualification_record' ||
    !['assigned', 'qualified'].includes(newer.lifecycle_state)
  ) {
    refuse('superseded_by names a qualification record in force', { field: 'superseded_by' });
  }
};

export const QUALIFICATION_MATERIALIZERS: Readonly<Record<string, ActionMaterializer>> = {
  draft_qualification_pack: draftQualificationPack,
  assign_qualification: assignQualification,
};

export const QUALIFICATION_EFFECTS: Readonly<Record<string, ActionEffect>> = {
  draft_qualification_pack: draftQualificationPackEffect,
  approve_qualification_pack: approvePackEffect,
  supersede_qualification_pack: supersedePackEffect,
  assign_qualification: assignQualificationEffect,
  submit_qualification_evidence: submitEvidenceEffect,
  credit_qualification_evidence: creditEvidenceEffect,
  accept_qualification: acceptQualificationEffect,
};

export const QUALIFICATION_PRECONDITIONS: Readonly<Record<string, PreconditionCheck>> = {
  approve_qualification_pack: approvePackPrecondition,
  supersede_qualification_pack: supersedePackPrecondition,
  retire_qualification_pack: retirePackPrecondition,
  withdraw_qualification: withdrawPrecondition,
  supersede_qualification: supersedeRecordPrecondition,
};

const receiptRows = async (tx: Tx, actionId: string) =>
  tx.query<{
    id: string;
    requirement_key: string;
    requirement_revision: number;
    evidence_mode: string;
  }>(
    `select id, requirement_key, requirement_revision, evidence_mode from org.qualification_credit
      where credited_by_action = $1 order by requirement_key`,
    [actionId],
  );

export const QUALIFICATION_RECEIPTS: Readonly<Record<string, ActionReceiptReader>> = {
  draft_qualification_pack: async (tx, actionId) => {
    const row = await tx.one<{ pack_id: string; revision: number; document_digest: string }>(
      `select pack_id, revision, document_digest from org.qualification_pack_revision
        where drafted_by_action = $1`,
      [actionId],
    );
    return { packId: row.pack_id, revision: row.revision, documentDigest: row.document_digest };
  },
  supersede_qualification_pack: async (tx, actionId) => {
    const row = await tx.one<{ pack_id: string; revision: number; document_digest: string }>(
      `select pack_id, revision, document_digest from org.qualification_pack_revision
        where drafted_by_action = $1`,
      [actionId],
    );
    return { packId: row.pack_id, revision: row.revision, documentDigest: row.document_digest };
  },
  assign_qualification: async (tx, actionId) => {
    const row = await tx.one<{ id: string; pack_revision: number }>(
      'select id, pack_revision from org.qualification_record where assigned_by_action = $1',
      [actionId],
    );
    return { recordId: row.id, packRevision: row.pack_revision };
  },
  credit_qualification_evidence: async (tx, actionId) => ({
    credits: (await receiptRows(tx, actionId)).map((c) => ({
      id: c.id,
      requirementKey: c.requirement_key,
      revision: c.requirement_revision,
      mode: c.evidence_mode,
    })),
  }),
  accept_qualification: async (tx, actionId) => ({
    credits: (await receiptRows(tx, actionId)).map((c) => ({
      id: c.id,
      requirementKey: c.requirement_key,
      revision: c.requirement_revision,
      mode: c.evidence_mode,
    })),
  }),
};
