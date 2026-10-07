#!/usr/bin/env node
// Load the Véracier fixture into a running fixture stack, through the paths a real institution
// uses. `pnpm fixture:veracier [--sample]`, after `fixtures/veracier/stack/stack.sh up`.
//
//   1. bootstrap tier (owner credential, the real `kf` CLI): the organization and its people
//      (`kf bootstrap-organization`), the counterparties' organizations, and each person's
//      authority — identity link, role assignment ending within a year, clearance
//      (`kf grant-authority`, granted by the CEO; hers is the founding grant).
//   2. accounts: one Keycloak account per person, password generated once into the single 0600
//      file ~/.config/kf/veracier-personas.txt (never printed).
//   3. documents: each PDF is `POST /ingest`ed by the Group Records Office as herself, with the
//      classification the overlay decides; its extracted text follows as a second artifact that
//      names the PDF it was derived from.
//   4. need-to-know: `grant_access` acts, one per reader per artifact, by the Records Office.
//   5. records: projects, engagements, requirements, NCRs … each a dispatched act by the person
//      the overlay names, followed by the grants that let its team read it.
//   6. observations: `POST /capture/observation` as the person who noticed.
//   7. roles as presets of scope (ADR 0040, fixtures/veracier/roles.mjs): the role names
//      (`kf define-role`), each person's preset roles (`kf grant-authority`), and the presets —
//      inclusions, organization-wide reading, each team's documents and records — and the living
//      organization overview, each an act by the CEO. A document or record read by exactly one
//      team reaches its readers through the team's preset instead of one grant per reader.
//   8. qualification (ADR 0038, fixtures/veracier/qualification.mjs): the common part, then the
//      chief-executive and aero-engineer packs, each DRAFTED by the quality director over the
//      records the steps above created. Approving a pack is the technical authority's
//      institutional act (decision 13) and the owner's to perform, so the loader stops at drafts
//      and says which approval each waits on; the two role packs compose the approved common part
//      and are drafted on the run after it is approved.
//
// Idempotent by replay: every act carries a deterministic idempotency key, so a second run
// changes nothing and reports each act as replayed ("0 new"). The bootstrap commands reuse what
// exists. A run against a database that holds a DIFFERENT fixture under the same keys stops at
// the first idempotency conflict and says so.

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapLimit, ownerSession } from '../lib/kf.mjs';
import {
  REPO,
  Tally,
  bootstrapCounterparties,
  bootstrapOrganization,
  ensureAccounts,
  grantAuthorities,
  grantRead,
  log,
  personaSessions,
  readJson,
  reindex,
} from '../lib/loader.mjs';
import { personasFile, stackSettings } from '../lib/stack.mjs';
import { AERO, CEO, COMMON, veracierPacks } from './qualification.mjs';
import {
  INCLUSIONS,
  ORGANIZATION_WIDE,
  ROLE_DEFINITIONS,
  TEAMS,
  holders,
  teamOf,
} from './roles.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const stack = stackSettings();
  const out = {
    sample: false,
    reindexOnly: false,
    corpus: process.env.KF_VERACIER_CORPUS ?? '/mnt/4tb/data/veracier',
    state: stack.state,
    personas: personasFile('veracier'),
    stack,
    jobs: 4,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--sample') out.sample = true;
    else if (a === '--reindex') out.reindexOnly = true;
    else if (a === '--corpus') out.corpus = argv[++i];
    else if (a === '--jobs') out.jobs = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        'usage: pnpm fixture:veracier [--sample] [--corpus <dir>] [--jobs <n>] | --reindex\n',
      );
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(out.jobs) || out.jobs < 1 || out.jobs > 8) throw new Error('--jobs 1..8');
  return out;
}

const counts = new Tally();
const tally = (what, replayed) => counts.add(what, replayed);

async function bootstrap(opts, owner, overlay) {
  const { company, people, records } = overlay;
  const ceo = people.find((p) => p.persona === 'ceo');
  const { organizationId, personIds } = await bootstrapOrganization(owner, {
    legalName: company.legal_name,
    kind: 'company',
    founder: ceo,
    people,
  });
  const counterparties = await bootstrapCounterparties(owner, records.counterparties);
  return { organizationId, personIds, counterparties, ceo };
}

async function accounts(opts, overlay) {
  return ensureAccounts(
    opts.stack,
    overlay.people,
    opts.personas,
    'Véracier fixture personas — local Keycloak passwords (fixtures/veracier).',
  );
}

async function authority(opts, owner, overlay, boot, subjects) {
  return grantAuthorities(owner, {
    people: overlay.people,
    founder: boot.ceo,
    organizationId: boot.organizationId,
    personIds: boot.personIds,
    subjects,
    issuer: opts.stack.oidc.issuer,
    reason: (p) =>
      `Véracier authority matrix VER-GOV-2026-01: ${p.name}, ${p.title}, acts as ${p.role} ` +
      `cleared to ${p.clearance}` +
      (p.ceiling === p.clearance ? '' : `, organization-wide reading capped at ${p.ceiling}`),
  });
}

function reasonFor(doc) {
  return `Véracier document estate migration (EDiTh ${doc.doc_id}): ${doc.entity}/${doc.path}, classified ${doc.classification} under rule ${doc.classification_rule}`;
}

async function documents(opts, overlay, sessions, ids) {
  log(
    `== documents (POST /ingest as the Group Records Office, ${overlay.documents.length} PDFs + text)`,
  );
  const office = sessions.get(overlay.people.find((p) => p.persona === 'records').key);
  const textDir = path.join(opts.corpus, 'text');
  const refused = [];
  await mapLimit(overlay.documents, opts.jobs, async (doc, index) => {
    const entry = (ids.documents[doc.doc_id] ??= {});
    const pdf = await readFile(path.join(opts.corpus, 'by_entity', doc.entity, doc.path));
    try {
      const res = await office.request('POST', '/ingest', {
        title: doc.title,
        artifactKind: 'document',
        classification: doc.classification,
        mediaType: 'application/pdf',
        contentBase64: pdf.toString('base64'),
        reason: reasonFor(doc),
        idempotencyKey: `veracier-v1:pdf:${doc.doc_id}:${doc.pdf_sha256.slice(0, 16)}`,
      });
      entry.artifactId = res.body.artifactId;
      tally('document (PDF)', res.body.replayed);
    } catch (error) {
      refused.push({
        doc: doc.doc_id,
        path: `${doc.entity}/${doc.path}`,
        what: 'pdf',
        error: String(error.message ?? error),
      });
      return;
    }
    const text = await readFile(path.join(textDir, doc.entity, `${doc.path}.txt`));
    try {
      const res = await office.request('POST', '/ingest', {
        title: `${doc.title} — texte extrait (${doc.text_method})`,
        artifactKind: 'document',
        classification: doc.classification,
        mediaType: 'text/plain',
        contentBase64: text.toString('base64'),
        derivedFrom: entry.artifactId,
        revisionLabel: `extracted:${doc.text_method}`,
        reason: `Text extracted from ${doc.doc_id} by fixtures/veracier/extract-text.mjs (${doc.text_method}); the PDF remains the record`,
        idempotencyKey: `veracier-v1:text:${doc.doc_id}:${doc.text_sha256.slice(0, 16)}`,
      });
      entry.textArtifactId = res.body.artifactId;
      tally('document (extracted text)', res.body.replayed);
    } catch (error) {
      refused.push({
        doc: doc.doc_id,
        path: `${doc.entity}/${doc.path}`,
        what: 'text',
        error: String(error.message ?? error),
      });
    }
    if ((index + 1) % 100 === 0) log(`  ${index + 1}/${overlay.documents.length}`);
  });
  for (const r of refused) log(`  REFUSED ${r.what} ${r.path}: ${r.error}`);
  return refused;
}

function grant(office, targetId, principalId, reason, key) {
  return grantRead(office, targetId, principalId, reason, key, counts);
}

async function needToKnow(opts, overlay, sessions, boot, ids) {
  const office = sessions.get(overlay.people.find((p) => p.persona === 'records').key);
  const byKey = new Map(overlay.people.map((p) => [p.key, p]));
  const work = [];
  for (const doc of overlay.documents) {
    const entry = ids.documents[doc.doc_id];
    if (entry === undefined) continue;
    // Read by exactly one team: the team's preset grants it (presets(), below).
    if (teamOf(doc.readers) !== undefined) continue;
    for (const reader of doc.readers) {
      for (const [target, kind] of [
        [entry.artifactId, 'pdf'],
        [entry.textArtifactId, 'text'],
      ]) {
        if (target === undefined) continue;
        work.push({ target, reader, kind, doc });
      }
    }
  }
  log(`== need-to-know (grant_access by the Records Office, ${work.length} grants)`);
  await mapLimit(work, opts.jobs, async ({ target, reader, kind, doc }, index) => {
    const person = byKey.get(reader);
    await grant(
      office,
      target,
      boot.personIds[reader],
      `Need-to-know matrix VER-GOV-RIM-001: ${person.title} (${person.entity}) reads ${doc.entity}/${doc.path}`,
      `veracier-v1:grant:${kind}:${doc.doc_id}:${reader}`,
    );
    if ((index + 1) % 500 === 0) log(`  ${index + 1}/${work.length}`);
  });
}

class Unresolved extends Error {}

function resolveRefs(value, refs) {
  if (typeof value === 'string') {
    const m = /^@(doc|text|textversion|rec|person|org|self)(?::(.+))?$/.exec(value);
    if (m === null) return value;
    const [, kind, key] = m;
    const found =
      kind === 'doc'
        ? refs.ids.documents[key]?.artifactId
        : kind === 'text'
          ? refs.ids.documents[key]?.textArtifactId
          : kind === 'textversion'
            ? refs.ids.documents[key]?.textVersionId
            : kind === 'rec'
              ? refs.ids.records[key]
              : kind === 'person'
                ? refs.boot.personIds[key]
                : kind === 'org'
                  ? refs.boot.counterparties[key]
                  : refs.boot.organizationId;
    if (found === undefined) throw new Unresolved(value);
    return found;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, refs));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, refs)]));
  }
  return value;
}

/** The newest version of each text artifact a record's payload names, read on the owner side. */
async function textVersions(owner, boot, overlay, ids) {
  for (const record of overlay.records.records) {
    for (const [, doc] of JSON.stringify(record).matchAll(/"@textversion:([^"]+)"/g)) {
      const entry = ids.documents[doc];
      if (entry?.textArtifactId === undefined || entry.textVersionId !== undefined) continue;
      const row = (
        await owner.scoped(
          boot.organizationId,
          'select id from content.artifact_version where artifact_id = $1 order by version_no desc limit 1',
          [entry.textArtifactId],
        )
      )[0];
      if (row !== undefined) entry.textVersionId = row.id;
    }
  }
}

async function governedRecords(opts, owner, overlay, sessions, boot, ids) {
  const list = overlay.records.records;
  log(`== records (${list.length} acts, each by the person the overlay names)`);
  await textVersions(owner, boot, overlay, ids);
  const office = sessions.get(overlay.people.find((p) => p.persona === 'records').key);
  const skipped = [];
  for (const record of list) {
    const actor = sessions.get(record.actor);
    const refs = { ids, boot };
    let request;
    let evidence;
    try {
      request = {
        targetIds: resolveRefs(record.targets ?? [], refs),
        idempotencyKey: `veracier-v1:record:${record.ref}`,
        reason: record.reason,
        payload: resolveRefs(
          record.type === 'record_observation' || record.creates === false
            ? (record.payload ?? {})
            : { ...(record.payload ?? {}), classification: record.classification },
          refs,
        ),
      };
      evidence = (record.evidence ?? []).map((d) => resolveRefs(`@doc:${d}`, refs));
    } catch (error) {
      // In --sample a record whose documents were not loaded is left out, with what it needed.
      if (!(error instanceof Unresolved)) throw error;
      skipped.push(`${record.ref} (${error.message})`);
      continue;
    }
    if (record.type === 'record_observation') {
      const res = await actor.request('POST', '/capture/observation', {
        body: request.payload.body,
        ...(request.payload.subjects === undefined ? {} : { subjects: request.payload.subjects }),
        ...(request.payload.tags === undefined ? {} : { tags: request.payload.tags }),
        gesture_id: `veracier-${record.ref}`,
      });
      ids.records[record.ref] = res.body.observationId;
      tally('record_observation', res.body.replayed === true);
    } else {
      const res = await actor.act(record.type, request);
      if (record.creates !== false) ids.records[record.ref] = res.body.objectIds?.[0];
      tally(record.type, res.status === 200);
    }
    const recordId = ids.records[record.ref];
    // The documents a record rests on, linked to it: an observation by its author whose subjects
    // are the record and each source PDF, so every one of them carries a `concerns` edge.
    if (recordId !== undefined && evidence.length > 0) {
      const res = await actor.request('POST', '/capture/observation', {
        body: `Pièces justificatives rattachées lors de la reprise du fonds documentaire : ${evidence.length} document(s).`,
        subjects: [recordId, ...evidence],
        tags: ['pieces-justificatives'],
        gesture_id: `veracier-evidence-${record.ref}`,
      });
      ids.records[`${record.ref}#evidence`] = res.body.observationId;
      tally('evidence link (observation)', res.body.replayed === true);
    }
    // Read by exactly one team: the team's preset grants it (presets(), below).
    for (const reader of teamOf(record.readers) === undefined ? (record.readers ?? []) : []) {
      if (recordId === undefined) continue;
      await grant(
        office,
        recordId,
        boot.personIds[reader],
        `Need-to-know matrix VER-GOV-RIM-001: ${record.ref} is read by its team`,
        `veracier-v1:grant:record:${record.ref}:${reader}`,
      );
    }
  }
  if (skipped.length > 0)
    log(`  left out (their documents are not in this run): ${skipped.join('; ')}`);
}

/**
 * The preset roles: their names (`kf define-role`, owner credential, idempotent) and each person's
 * assignments of them (`kf grant-authority`, granted by the CEO, ending within a year). An
 * assignment of a preset role carries the person's matrix ceiling, so the organization-wide
 * reading every assignment confers is no wider than the one they already held.
 */
async function presetRoles(owner, overlay, boot) {
  log('== roles (kf define-role; kf grant-authority for each preset role a person holds)');
  for (const [id, description] of ROLE_DEFINITIONS) {
    await owner.kf(['define-role', '--id', id, '--description', description]);
  }
  const held = holders(overlay.people);
  let changed = 0;
  for (const p of overlay.people) {
    for (const role of [...held.get(p.key)].sort()) {
      const args = [
        'grant-authority',
        '--person',
        boot.personIds[p.key],
        '--organization',
        boot.organizationId,
        '--role',
        role,
        '--clearance',
        p.clearance,
        '--granted-by',
        boot.personIds[boot.ceo.key],
        '--reason',
        `Véracier role presets (ADR 0040): ${p.name}, ${p.title}, holds ${role}`,
      ];
      if (p.ceiling !== p.clearance) args.push('--role-ceiling', p.ceiling);
      const out = await owner.kf(args);
      if (!/already held|nothing to change|unchanged/i.test(out)) changed += 1;
    }
  }
  log(`  ${ROLE_DEFINITIONS.length} roles; ${changed} preset-role assignments made`);
}

/**
 * The presets, each an institutional act by the CEO under the authority matrix: inclusions, the
 * organization-wide reading, each team's documents and records, and the living organization
 * overview, which every person reaches through `staff`.
 */
async function presets(opts, overlay, sessions, boot, ids) {
  const ceo = sessions.get(boot.ceo.key);
  const org = boot.organizationId;
  const act = async (type, targetIds, payload, key, reason) => {
    try {
      const res = await ceo.act(type, { targetIds, idempotencyKey: key, reason, payload });
      tally(type, res.status === 200);
    } catch (error) {
      // Already part of the preset under another key (an earlier run): the same decision.
      if (
        error instanceof Error &&
        /already part of the preset|already has an active/.test(error.message)
      ) {
        tally(type, true);
        return;
      }
      throw error;
    }
  };
  log('== presets (include_role, grant_role_scope, declare_organization_overview, by the CEO)');
  for (const [role, included] of INCLUSIONS) {
    await act(
      'include_role',
      [org],
      { role_id: role, included_role_id: included },
      `veracier-v1:include:${role}:${included}`,
      `Véracier authority matrix VER-GOV-2026-01: ${role} includes ${included}`,
    );
  }
  for (const [role, ceiling] of ORGANIZATION_WIDE) {
    await act(
      'grant_role_scope',
      [org],
      { role_id: role, capability: 'read', classification_ceiling: ceiling },
      `veracier-v1:preset:${role}:read:organization`,
      `Véracier authority matrix VER-GOV-2026-01: ${role} reads the group up to ${ceiling}`,
    );
  }
  // The overview: one record, declared once, read by everyone through staff.
  if (ids.overviewId === undefined) {
    const res = await ceo.act('declare_organization_overview', {
      targetIds: [org],
      idempotencyKey: 'veracier-v1:overview',
      reason: 'The living overview of Véracier Industries, generated for each reader',
      payload: { title: 'Véracier Industries — vue d’ensemble', classification: 'internal' },
    });
    ids.overviewId = res.body.objectIds?.find((id) => id !== org);
    tally('declare_organization_overview', res.status === 200);
  }
  if (ids.overviewId !== undefined) {
    await act(
      'grant_role_scope',
      [org, ids.overviewId],
      { role_id: 'staff', capability: 'read' },
      `veracier-v1:preset:staff:read:overview`,
      'Everyone at Véracier reads the living organization overview',
    );
  }
  const work = [];
  for (const doc of overlay.documents) {
    const team = teamOf(doc.readers);
    const entry = ids.documents[doc.doc_id];
    if (team === undefined || entry === undefined) continue;
    for (const [target, kind] of [
      [entry.artifactId, 'pdf'],
      [entry.textArtifactId, 'text'],
    ]) {
      if (target !== undefined) work.push({ team, target, what: `${kind}:${doc.doc_id}` });
    }
  }
  for (const record of overlay.records.records) {
    const team = teamOf(record.readers);
    const target = ids.records[record.ref];
    if (team !== undefined && target !== undefined) {
      work.push({ team, target, what: `record:${record.ref}` });
    }
  }
  log(`  ${work.length} team templates (${Object.keys(TEAMS).length} teams)`);
  await mapLimit(work, opts.jobs, async ({ team, target, what }) =>
    act(
      'grant_role_scope',
      [org, target],
      { role_id: team, capability: 'read' },
      `veracier-v1:preset:${team}:read:${what}`,
      `Need-to-know matrix VER-GOV-RIM-001: ${team} reads ${what}`,
    ),
  );
}

/**
 * The bootstrap tier writes people, role assignments and organizations directly (its one
 * exception to the dispatcher), so no outbox row announces them and the worker never indexes
 * them; readiness then reports them as unfindable. The index is disposable and rebuilt by the
 * worker's own login, which is what this does: it touches no record.
 *
 * The same login then queues every indexed record for embedding (`retrieval.enqueue_embedding`,
 * the derived queue's documented rebuild; the ids are listed on the owner credential, because the
 * worker's login reads the index under row security and sees none of it). Records the worker
 * delivered while no retrieval engine was attached were indexed and never embedded, and the
 * bootstrap tier's were never delivered at all; the worker's embedding pump sends each through
 * the engine's vectors-only write once one is attached (KF_RETRIEVAL_SOCKET). Without an engine
 * the queue waits. `--reindex` runs only this; a load uses the shared `reindex` for the
 * bootstrap tier's objects, and the worker embeds the rest as it indexes them.
 */
async function reindexAll(opts) {
  const file = path.join(opts.state, 'knowledge-fabric', 'worker-database-url');
  if (!existsSync(file)) {
    log('  (no worker login in the state directory: search index not rebuilt)');
    return;
  }
  const { createPool, withTransaction } = await import('@kf/database');
  const pool = createPool({
    connectionString: (await readFile(file, 'utf8')).trim(),
    maxConnections: 1,
  });
  try {
    // In batches, one short transaction each (search.rebuild_batch, 20260926100100): one statement
    // over every record outlasts the statement budget on a stack holding tens of thousands.
    // A batch holding several large documents can still outlast the budget: halve it and carry on
    // from the same record, rather than failing the whole rebuild at record 30 000.
    let after = null;
    let rebuilt = 0;
    let size = 500;
    for (;;) {
      let batch;
      try {
        batch = await withTransaction(pool, (tx) =>
          tx.one('select indexed, last_object from search.rebuild_batch($1::uuid, $2)', [
            after,
            size,
          ]),
        );
      } catch (error) {
        if (error?.code !== '57014' || size === 1) throw error;
        size = Math.max(1, Math.floor(size / 2));
        log(`  (a batch outlasted the statement budget; continuing ${size} at a time)`);
        continue;
      }
      if (Number(batch.indexed) === 0 || batch.last_object === null) break;
      rebuilt += Number(batch.indexed);
      after = batch.last_object;
      if (rebuilt % 5000 < size) log(`  … ${rebuilt} records re-indexed`);
    }
    log(`== search index rebuilt by the worker's login: ${rebuilt} records`);
    // The worker's login reads search.document under row security and sees none of it, so the
    // ids come from the owner credential the bootstrap tier already uses; the enqueue itself is the
    // worker's, through the one seam granted to it.
    const owner = createPool({ connectionString: opts.stack.ownerUrl, maxConnections: 1 });
    let objectIds;
    try {
      objectIds = (
        await withTransaction(owner, (tx) =>
          tx.query('select object_id from search.document order by object_id'),
        )
      ).map((r) => r.object_id);
    } finally {
      await owner.end();
    }
    const queued = await withTransaction(pool, (tx) =>
      tx.one('select retrieval.enqueue_embedding($1::uuid[]) as n', [objectIds]),
    );
    log(`== queued for embedding by the worker's login: ${queued.n} records`);
  } finally {
    await pool.end();
  }
}

/**
 * The Véracier packs, drafted by the quality director (step 8). Each resource is referenced by
 * identifier and the revision it has now, read from the record; nothing is copied.
 */
async function qualificationPacks(owner, overlay, sessions, boot, ids) {
  const director = sessions.get(overlay.people.find((p) => p.persona === 'quality').key);
  const org = boot.organizationId;
  const need = {
    overview: ids.overviewId,
    procedures: ids.records['cd-fire-training'],
    ncrExample: ids.records['nc-0312-001'],
    authorityMatrix: ids.records['cd-incident-policy'],
    programme: ids.records['prj-ramp-up'],
  };
  const missing = Object.entries(need).filter(([, id]) => id === undefined);
  if (missing.length > 0) {
    log(
      `== qualification: skipped, these records are not loaded: ${missing.map(([k]) => k).join(', ')}`,
    );
    return;
  }
  const revisions = new Map(
    (
      await owner.scoped(
        org,
        `select o.id::text, coalesce(cd.revision, o.row_version::text) as revision
           from core.object o left join quality.controlled_document cd on cd.id = o.id
          where o.id = any($1::uuid[])`,
        [Object.values(need)],
      )
    ).map((row) => [row.id, row.revision]),
  );
  const ref = (id) => ({ id, revision: revisions.get(id) });
  const packs = veracierPacks({
    resources: Object.fromEntries(Object.entries(need).map(([k, id]) => [k, ref(id)])),
    scope: { av3000: need.programme },
    roles: { owner: 'quality_director', quality: 'quality_director', executive: 'executive' },
  });
  const state = async (key) =>
    (
      await owner.scoped(
        org,
        `select o.lifecycle_state as state from org.qualification_pack p
           join core.object o on o.id = p.id where p.organization_id = $1 and p.pack_key = $2`,
        [org, key],
      )
    )[0]?.state;
  log(
    '== qualification (draft_qualification_pack, by the quality director; approval is the owner’s)',
  );
  const draft = async (document) => {
    if ((await state(document.key)) !== undefined) {
      tally('draft_qualification_pack', true);
      return;
    }
    const res = await director.act('draft_qualification_pack', {
      targetIds: [],
      idempotencyKey: `veracier-v1:pack:${document.key}:${String(document.revision)}`,
      reason: `Véracier qualification pack ${document.key}`,
      payload: { document },
    });
    tally('draft_qualification_pack', res.status === 200);
  };
  await draft(packs.common);
  if ((await state(COMMON)) === 'approved') {
    await draft(packs.ceo);
    await draft(packs.aero);
  }
  for (const key of [COMMON, CEO, AERO]) {
    const now = await state(key);
    log(
      `  ${key}: ${
        now === undefined
          ? 'drafted once the common part is approved'
          : now === 'draft'
            ? 'drafted; waits on the owner’s approve_qualification_pack'
            : now
      }`,
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.reindexOnly) {
    process.env.PGPASSWORD ??= 'dev-only-not-a-secret';
    await reindexAll(opts);
    return;
  }
  const overlayDir = path.join(HERE, 'overlay');
  const overlay = {
    company: await readJson(path.join(overlayDir, 'company.json')),
    people: await readJson(path.join(overlayDir, 'people.json')),
    documents: await readJson(path.join(overlayDir, 'documents.json')),
    records: await readJson(path.join(overlayDir, 'records.json')),
  };
  if (opts.sample) {
    const sample = new Set((await readJson(path.join(overlayDir, 'sample.json'))).doc_ids);
    overlay.documents = overlay.documents.filter((d) => sample.has(d.doc_id));
  }
  log(
    `Véracier fixture → ${opts.stack.api} (${opts.sample ? 'sample' : 'full'}: ${overlay.documents.length} documents)`,
  );

  process.env.PGPASSWORD ??= 'dev-only-not-a-secret';
  const owner = ownerSession(REPO, opts.stack.ownerUrl);
  const idsFile = path.join(opts.state, 'veracier-ids.json');
  try {
    const boot = await bootstrap(opts, owner, overlay);
    const { subjects, passwords } = await accounts(opts, overlay);
    const assignments = await authority(opts, owner, overlay, boot, subjects);
    await presetRoles(owner, overlay, boot);

    const sessions = personaSessions(
      opts.stack,
      overlay.people,
      passwords,
      boot.organizationId,
      assignments,
    );
    const ids = existsSync(idsFile) ? await readJson(idsFile) : { documents: {}, records: {} };
    ids.organizationId = boot.organizationId;
    ids.people = Object.fromEntries(
      overlay.people.map((p) => [
        p.key,
        {
          personId: boot.personIds[p.key],
          assignmentId: assignments[p.key],
          subject: subjects[p.key],
        },
      ]),
    );
    const save = () => writeFile(idsFile, `${JSON.stringify(ids, null, 2)}\n`, { mode: 0o600 });
    try {
      const refused = await documents(opts, overlay, sessions, ids);
      await save();
      await needToKnow(opts, overlay, sessions, boot, ids);
      await governedRecords(opts, owner, overlay, sessions, boot, ids);
      await presets(opts, overlay, sessions, boot, ids);
      await qualificationPacks(owner, overlay, sessions, boot, ids);
      if (refused.length > 0)
        log(`  ${refused.length} ingest refusal(s) above; they are reported, not retried`);
      // Every assignment the bootstrap tier wrote, the preset roles' included.
      const held = await owner.scoped(
        boot.organizationId,
        `select id from core.object where organization_id = $1 and object_type = 'role_assignment'`,
        [boot.organizationId],
      );
      await reindex(opts.state, [
        boot.organizationId,
        ...Object.values(boot.personIds),
        ...Object.values(boot.counterparties),
        ...Object.values(assignments),
        ...held.map((row) => row.id),
      ]);
    } finally {
      await save();
    }
    counts.print();
    log(`  organization ${boot.organizationId}; ids in ${idsFile}`);
  } finally {
    await owner.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
