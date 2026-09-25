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
//
// Idempotent by replay: every act carries a deterministic idempotency key, so a second run
// changes nothing and reports each act as replayed ("0 new"). The bootstrap commands reuse what
// exists. A run against a database that holds a DIFFERENT fixture under the same keys stops at
// the first idempotency conflict and says so.

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminToken, ensureUser } from './lib/keycloak.mjs';
import { ApiError, PersonaSession, mapLimit, ownerSession } from './lib/kf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const REALM = 'knowledge-fabric';

function parseArgs(argv) {
  const out = {
    sample: false,
    reindexOnly: false,
    corpus: process.env.KF_VERACIER_CORPUS ?? '/mnt/4tb/data/veracier',
    state: process.env.KF_VERACIER_STATE ?? path.join(homedir(), '.local', 'state', 'kf-veracier'),
    personas:
      process.env.KF_VERACIER_PERSONAS ??
      path.join(homedir(), '.config', 'kf', 'veracier-personas.txt'),
    api: `http://127.0.0.1:${process.env.KF_VERACIER_API_PORT ?? '4100'}`,
    keycloak: process.env.KF_VERACIER_KEYCLOAK ?? 'http://localhost:18080',
    web: `http://localhost:${process.env.KF_VERACIER_WEB_PORT ?? '3100'}`,
    ownerUrl: 'postgres://kf_owner@localhost:15432/kf?sslmode=disable',
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

const log = (...parts) => process.stdout.write(`${parts.join(' ')}\n`);

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/** Each person's password, generated once and kept in ONE owner-only file. */
async function personaPasswords(file, people) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const known = new Map();
  if (existsSync(file)) {
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (line.startsWith('#') || line.trim() === '') continue;
      const [username, password] = line.split('\t');
      if (username && password) known.set(username, password);
    }
  }
  let added = 0;
  for (const p of people) {
    if (!known.has(p.username)) {
      known.set(p.username, randomBytes(18).toString('base64url'));
      added += 1;
    }
  }
  const lines = [
    '# Véracier fixture personas — local Keycloak passwords (fixtures/veracier). Owner-only.',
    '# username<TAB>password<TAB>name — title<TAB>persona',
    ...people.map((p) =>
      [p.username, known.get(p.username), `${p.name} — ${p.title}`, p.persona ?? ''].join('\t'),
    ),
    '',
  ];
  await writeFile(file, lines.join('\n'), { mode: 0o600 });
  await chmod(file, 0o600);
  return { passwords: known, added };
}

const counts = new Map();
function tally(what, replayed) {
  const c = counts.get(what) ?? { new: 0, replayed: 0 };
  c[replayed ? 'replayed' : 'new'] += 1;
  counts.set(what, c);
}

async function bootstrap(opts, owner, overlay) {
  const { company, people, records } = overlay;
  log('== bootstrap tier (owner credential, kf CLI)');
  const ceo = people.find((p) => p.persona === 'ceo');
  const lookupOrg = async () =>
    (await owner.query('select org.organization_by_name($1) as id', [company.legal_name]))[0]?.id ??
    null;
  let organizationId = await lookupOrg();
  if (organizationId === null) {
    await owner.kf([
      'bootstrap-organization',
      '--legal-name',
      company.legal_name,
      '--person',
      ceo.name,
      '--kind',
      'company',
    ]);
    organizationId = await lookupOrg();
    log(`  organization created: ${company.legal_name} ${organizationId}`);
  } else {
    log(`  organization exists: ${company.legal_name} ${organizationId}`);
  }
  const personId = async (name) =>
    (
      await owner.scoped(
        organizationId,
        'select id from org.person where organization = $1 and display_name = $2 order by id limit 1',
        [organizationId, name],
      )
    )[0]?.id;
  const ids = {};
  let createdPeople = 0;
  for (const p of people) {
    let id = await personId(p.name);
    if (id === undefined) {
      await owner.kf([
        'bootstrap-organization',
        '--organization',
        organizationId,
        '--person',
        p.name,
      ]);
      id = await personId(p.name);
      createdPeople += 1;
    }
    ids[p.key] = id;
  }
  log(`  people: ${people.length} (${createdPeople} created)`);

  const counterparties = {};
  for (const c of records.counterparties) {
    let id = (await owner.query('select org.organization_by_name($1) as id', [c.legal_name]))[0]
      ?.id;
    if (id === null || id === undefined) {
      await owner.kf([
        'bootstrap-organization',
        '--legal-name',
        c.legal_name,
        '--person',
        c.contact,
        '--kind',
        c.kind,
      ]);
      id = (await owner.query('select org.organization_by_name($1) as id', [c.legal_name]))[0].id;
    }
    counterparties[c.key] = id;
  }
  log(`  counterparty organizations: ${records.counterparties.length}`);
  return { organizationId, personIds: ids, counterparties, ceo };
}

async function accounts(opts, overlay) {
  log('== accounts (Keycloak, realm knowledge-fabric)');
  const { passwords, added } = await personaPasswords(opts.personas, overlay.people);
  const kcPassword = (
    await readFile(path.join(opts.state, 'keycloak-admin-password'), 'utf8')
  ).trim();
  const subjects = {};
  let created = 0;
  let token = await adminToken(opts.keycloak, kcPassword);
  let issued = Date.now();
  for (const p of overlay.people) {
    if (Date.now() - issued > 45_000) {
      token = await adminToken(opts.keycloak, kcPassword);
      issued = Date.now();
    }
    const user = await ensureUser(opts.keycloak, REALM, token, p, passwords.get(p.username));
    subjects[p.key] = user.subject;
    if (user.created) created += 1;
  }
  log(
    `  ${overlay.people.length} accounts (${created} created); passwords: ${opts.personas} (0600, ${added} new)`,
  );
  return { subjects, passwords };
}

async function authority(opts, owner, overlay, boot, subjects) {
  log('== authority (kf grant-authority: identity link, role assignment, clearance)');
  const issuer = `${opts.keycloak}/realms/${REALM}`;
  const ordered = [boot.ceo, ...overlay.people.filter((p) => p.key !== boot.ceo.key)];
  let changed = 0;
  for (const p of ordered) {
    const args = [
      'grant-authority',
      '--person',
      boot.personIds[p.key],
      '--organization',
      boot.organizationId,
      '--role',
      p.role,
      '--clearance',
      p.clearance,
      '--granted-by',
      boot.personIds[boot.ceo.key],
      '--issuer',
      issuer,
      '--subject',
      subjects[p.key],
      '--reason',
      `Véracier authority matrix VER-GOV-2026-01: ${p.name}, ${p.title}, acts as ${p.role} ` +
        `cleared to ${p.clearance}` +
        (p.ceiling === p.clearance ? '' : `, organization-wide reading capped at ${p.ceiling}`),
    ];
    if (p.ceiling !== p.clearance) args.push('--role-ceiling', p.ceiling);
    const out = await owner.kf(args);
    if (!/already held|nothing to change|unchanged/i.test(out)) changed += 1;
  }
  const assignments = {};
  for (const p of overlay.people) {
    const row = (
      await owner.scoped(
        boot.organizationId,
        `select id from org.role_assignment
          where subject_id = $1 and scope_id = $2 and role_id = $3
            and valid_from <= now() and (valid_to is null or valid_to > now())
          order by valid_from desc limit 1`,
        [boot.personIds[p.key], boot.organizationId, p.role],
      )
    )[0];
    if (row === undefined) throw new Error(`${p.name} holds no live ${p.role} assignment`);
    assignments[p.key] = row.id;
  }
  log(
    `  ${overlay.people.length} people authorized (${changed} grant-authority runs changed something)`,
  );
  return assignments;
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

async function grant(office, targetId, principalId, reason, key) {
  try {
    const res = await office.act('grant_access', {
      targetIds: [targetId],
      idempotencyKey: key,
      reason,
      payload: { principal_kind: 'person', principal_id: principalId, capability: 'read' },
    });
    tally('grant_access', res.status === 200);
  } catch (error) {
    // A live grant made by an earlier run under a different key is the same fact; anything else
    // is a real refusal.
    if (error instanceof ApiError && /already overlaps/.test(JSON.stringify(error.body))) {
      tally('grant_access', true);
      return;
    }
    throw error;
  }
}

async function needToKnow(opts, overlay, sessions, boot, ids) {
  const office = sessions.get(overlay.people.find((p) => p.persona === 'records').key);
  const byKey = new Map(overlay.people.map((p) => [p.key, p]));
  const work = [];
  for (const doc of overlay.documents) {
    const entry = ids.documents[doc.doc_id];
    if (entry === undefined) continue;
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
    for (const reader of record.readers ?? []) {
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
 * the queue waits. `--reindex` runs only this.
 */
async function reindex(opts) {
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
    const row = await withTransaction(pool, (tx) => tx.one('select search.rebuild() as n'));
    log(`== search index rebuilt by the worker's login: ${row.n} records`);
    // The worker's login reads search.document under row security and sees none of it, so the
    // ids come from the owner credential the bootstrap tier already uses; the enqueue itself is the
    // worker's, through the one seam granted to it.
    const owner = createPool({ connectionString: opts.ownerUrl, maxConnections: 1 });
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.reindexOnly) {
    process.env.PGPASSWORD ??= 'dev-only-not-a-secret';
    await reindex(opts);
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
    `Véracier fixture → ${opts.api} (${opts.sample ? 'sample' : 'full'}: ${overlay.documents.length} documents)`,
  );

  process.env.PGPASSWORD ??= 'dev-only-not-a-secret';
  const owner = ownerSession(REPO, opts.ownerUrl);
  const idsFile = path.join(opts.state, 'veracier-ids.json');
  try {
    const boot = await bootstrap(opts, owner, overlay);
    const { subjects, passwords } = await accounts(opts, overlay);
    const assignments = await authority(opts, owner, overlay, boot, subjects);

    const oidc = {
      issuer: `${opts.keycloak}/realms/${REALM}`,
      clientId: 'knowledge-fabric-web',
      redirectUri: `${opts.web}/auth/callback`,
    };
    const sessions = new Map(
      overlay.people.map((p) => [
        p.key,
        new PersonaSession({
          oidc,
          apiOrigin: opts.api,
          person: p,
          password: passwords.get(p.username),
          organizationId: boot.organizationId,
          assignmentId: assignments[p.key],
        }),
      ]),
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
      if (refused.length > 0)
        log(`  ${refused.length} ingest refusal(s) above; they are reported, not retried`);
      await reindex(opts);
    } finally {
      await save();
    }
    log('== summary (new / replayed)');
    for (const [what, c] of [...counts].sort())
      log(`  ${what.padEnd(28)} ${c.new} / ${c.replayed}`);
    const fresh = [...counts.values()].reduce((n, c) => n + c.new, 0);
    log(
      fresh === 0 ? '  nothing new: this database already held the fixture' : `  ${fresh} new acts`,
    );
    log(`  organization ${boot.organizationId}; ids in ${idsFile}`);
  } finally {
    await owner.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
