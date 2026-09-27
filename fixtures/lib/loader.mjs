/* global setTimeout */
// The load steps every fixture corpus shares, extracted from the Véracier loader.
//
//   bootstrap tier (owner credential, the real `kf` CLI)
//     bootstrapOrganization   `kf bootstrap-organization`: the organization, then each person
//     bootstrapCounterparties the other organizations a fixture's records name
//     grantAuthorities        `kf grant-authority`: identity link, role, clearance, ceiling;
//                             the founder's first, every assignment ending within a year
//   accounts                  one Keycloak account per person; passwords generated once into ONE
//                             0600 file per corpus (personaPasswords), never printed
//   everything else           a request to the running API as the person who performs it
//                             (PersonaSession): ingestDocuments, grantRead
//   reindex                   search.index_object() of what the bootstrap tier wrote, on the
//                             worker's own login
//
// `loadDocumentCorpus` composes them for a corpus that is documents, people and need-to-know
// grants (EnterpriseRAG-Bench, DRBench, TheAgentCompany). Véracier composes the same steps with
// its governed records in fixtures/veracier/load.mjs.
//
// Idempotent by replay: every act carries a deterministic idempotency key, so a second run
// changes nothing and says so.

import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminToken, ensureUser } from './keycloak.mjs';
import { ApiError, PersonaSession, mapLimit, ownerSession } from './kf.mjs';
import { REALM, personasFile, stackSettings } from './stack.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const log = (...parts) => process.stdout.write(`${parts.join(' ')}\n`);

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function readJsonLines(file) {
  return (await readFile(file, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** username → password from a personas file (tab-separated; `#` lines are comments). */
export async function readPasswords(file) {
  const known = new Map();
  if (!existsSync(file)) return known;
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const [username, password] = line.split('\t');
    if (username && password) known.set(username, password);
  }
  return known;
}

/** Each person's password, generated once and kept in ONE owner-only file. */
export async function personaPasswords(file, people, heading) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const known = await readPasswords(file);
  let added = 0;
  for (const p of people) {
    if (!known.has(p.username)) {
      known.set(p.username, randomBytes(18).toString('base64url'));
      added += 1;
    }
  }
  // Lines for people this run does not name are kept as they were: one file may serve several
  // organizations of one corpus (DRBench's three companies), each loaded on its own.
  const named = new Set(people.map((p) => p.username));
  const others = existsSync(file)
    ? (await readFile(file, 'utf8'))
        .split('\n')
        .filter((l) => !l.startsWith('#') && l.trim() !== '' && !named.has(l.split('\t')[0]))
    : [];
  const lines = [
    `# ${heading} Owner-only.`,
    '# username<TAB>password<TAB>name — title<TAB>persona',
    ...others,
    ...people.map((p) =>
      [p.username, known.get(p.username), `${p.name} — ${p.title}`, p.persona ?? ''].join('\t'),
    ),
    '',
  ];
  await writeFile(file, lines.join('\n'), { mode: 0o600 });
  await chmod(file, 0o600);
  return { passwords: known, added };
}

/**
 * New / replayed counts per kind of act, and the run's one-line verdict. A refusal the product
 * makes on purpose (`refuse`) is counted apart: it recurs on every run and is not a new act.
 */
export class Tally {
  #counts = new Map();
  #refused = new Map();
  add(what, replayed) {
    const c = this.#counts.get(what) ?? { new: 0, replayed: 0 };
    c[replayed ? 'replayed' : 'new'] += 1;
    this.#counts.set(what, c);
  }
  refuse(what) {
    this.#refused.set(what, (this.#refused.get(what) ?? 0) + 1);
  }
  get fresh() {
    return [...this.#counts.values()].reduce((n, c) => n + c.new, 0);
  }
  print() {
    log('== summary (new / replayed)');
    for (const [what, c] of [...this.#counts].sort())
      log(`  ${what.padEnd(28)} ${c.new} / ${c.replayed}`);
    for (const [what, n] of [...this.#refused].sort()) log(`  ${what.padEnd(28)} ${n}`);
    log(
      this.fresh === 0
        ? '  nothing new: this database already held the fixture'
        : `  ${this.fresh} new acts`,
    );
  }
}

async function organizationByName(owner, legalName) {
  return (
    (await owner.query('select org.organization_by_name($1) as id', [legalName]))[0]?.id ?? null
  );
}

/**
 * The organization and its people, through `kf bootstrap-organization`, reusing what exists.
 * `founder` is the person the organization is bootstrapped with; people are matched by name.
 */
export async function bootstrapOrganization(
  owner,
  { legalName, kind = 'company', founder, people },
) {
  log('== bootstrap tier (owner credential, kf CLI)');
  let organizationId = await organizationByName(owner, legalName);
  if (organizationId === null) {
    await owner.kf([
      'bootstrap-organization',
      '--legal-name',
      legalName,
      '--person',
      founder.name,
      '--kind',
      kind,
    ]);
    organizationId = await organizationByName(owner, legalName);
    log(`  organization created: ${legalName} ${organizationId}`);
  } else {
    log(`  organization exists: ${legalName} ${organizationId}`);
  }
  const personId = async (name) =>
    (
      await owner.scoped(
        organizationId,
        'select id from org.person where organization = $1 and display_name = $2 order by id limit 1',
        [organizationId, name],
      )
    )[0]?.id;
  const personIds = {};
  let created = 0;
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
      created += 1;
    }
    personIds[p.key] = id;
  }
  log(`  people: ${people.length} (${created} created)`);
  return { organizationId, personIds };
}

/** Counterparty organizations (`{ key, legal_name, contact, kind }`), created when absent. */
export async function bootstrapCounterparties(owner, counterparties) {
  const ids = {};
  for (const c of counterparties) {
    let id = await organizationByName(owner, c.legal_name);
    if (id === null) {
      await owner.kf([
        'bootstrap-organization',
        '--legal-name',
        c.legal_name,
        '--person',
        c.contact,
        '--kind',
        c.kind,
      ]);
      id = await organizationByName(owner, c.legal_name);
    }
    ids[c.key] = id;
  }
  log(`  counterparty organizations: ${counterparties.length}`);
  return ids;
}

/** One Keycloak account per person (created when absent; a password is set only on creation). */
export async function ensureAccounts(settings, people, personas, heading) {
  log(`== accounts (Keycloak, realm ${REALM})`);
  const { passwords, added } = await personaPasswords(personas, people, heading);
  const kcPassword = (
    await readFile(path.join(settings.state, 'keycloak-admin-password'), 'utf8')
  ).trim();
  const subjects = {};
  let created = 0;
  let token = await adminToken(settings.keycloak, kcPassword);
  let issued = Date.now();
  for (const p of people) {
    if (Date.now() - issued > 45_000) {
      token = await adminToken(settings.keycloak, kcPassword);
      issued = Date.now();
    }
    const user = await ensureUser(settings.keycloak, REALM, token, p, passwords.get(p.username));
    subjects[p.key] = user.subject;
    if (user.created) created += 1;
  }
  log(
    `  ${people.length} accounts (${created} created); passwords: ${personas} (0600, ${added} new)`,
  );
  return { subjects, passwords };
}

/**
 * `kf grant-authority` for every person, the founder first (theirs is the founding grant; every
 * other is granted by them), then each person's live assignment id.
 */
export async function grantAuthorities(
  owner,
  { people, founder, organizationId, personIds, subjects, issuer, reason },
) {
  log('== authority (kf grant-authority: identity link, role assignment, clearance)');
  const ordered = [founder, ...people.filter((p) => p.key !== founder.key)];
  let changed = 0;
  for (const p of ordered) {
    const args = [
      'grant-authority',
      '--person',
      personIds[p.key],
      '--organization',
      organizationId,
      '--role',
      p.role,
      '--clearance',
      p.clearance,
      '--granted-by',
      personIds[founder.key],
      '--issuer',
      issuer,
      '--subject',
      subjects[p.key],
      '--reason',
      reason(p),
    ];
    if (p.ceiling !== p.clearance) args.push('--role-ceiling', p.ceiling);
    const out = await owner.kf(args);
    if (!/already held|nothing to change|unchanged/i.test(out)) changed += 1;
  }
  const assignments = {};
  for (const p of people) {
    const row = (
      await owner.scoped(
        organizationId,
        `select id from org.role_assignment
          where subject_id = $1 and scope_id = $2 and role_id = $3
            and valid_from <= now() and (valid_to is null or valid_to > now())
          order by valid_from desc limit 1`,
        [personIds[p.key], organizationId, p.role],
      )
    )[0];
    if (row === undefined) throw new Error(`${p.name} holds no live ${p.role} assignment`);
    assignments[p.key] = row.id;
  }
  log(`  ${people.length} people authorized (${changed} grant-authority runs changed something)`);
  return assignments;
}

/** A `read` grant to one person at one object, by `office`. An overlapping live grant is the same fact. */
export async function grantRead(office, targetId, principalId, reason, key, tally) {
  try {
    const res = await office.act('grant_access', {
      targetIds: [targetId],
      idempotencyKey: key,
      reason,
      payload: { principal_kind: 'person', principal_id: principalId, capability: 'read' },
    });
    tally.add('grant_access', res.status === 200);
  } catch (error) {
    if (error instanceof ApiError && /already overlaps/.test(JSON.stringify(error.body))) {
      tally.add('grant_access', true);
      return;
    }
    throw error;
  }
}

/** One PersonaSession per person, each in their own context (organization, assignment). */
export function personaSessions(settings, people, passwords, organizationId, assignments) {
  return new Map(
    people.map((p) => [
      p.key,
      new PersonaSession({
        oidc: settings.oidc,
        apiOrigin: settings.api,
        person: p,
        password: passwords.get(p.username),
        organizationId,
        assignmentId: assignments[p.key],
      }),
    ]),
  );
}

/**
 * The bootstrap tier writes people, role assignments and organizations directly (its one
 * exception to the dispatcher), so no outbox row announces them and the worker never indexes
 * them; readiness then reports them as unfindable. The worker's own login indexes exactly those
 * objects (`search.index_object`, what the outbox would have run). The index is disposable and
 * this touches no record. A whole rebuild would do too (`stack.sh reindex`, in batches since
 * 20260926100100), but re-indexes every record rather than the few the bootstrap tier wrote.
 */
export async function reindex(state, objectIds) {
  const file = path.join(state, 'knowledge-fabric', 'worker-database-url');
  if (!existsSync(file)) {
    log('  (no worker login in the state directory: search index not updated)');
    return;
  }
  const ids = [...new Set(objectIds.filter(Boolean))];
  const { createPool, withTransaction } = await import('@kf/database');
  const pool = createPool({
    connectionString: (await readFile(file, 'utf8')).trim(),
    maxConnections: 1,
  });
  try {
    // The worker indexes the outbox on the same rows while a load runs; a deadlock between the
    // two is retried, not reported.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await withTransaction(pool, (tx) =>
          tx.query('select search.index_object(id) from unnest($1::uuid[]) as id', [ids]),
        );
        log(
          `== search index: the bootstrap tier's ${ids.length} objects indexed by the worker's login`,
        );
        return;
      } catch (error) {
        if (error?.code !== '40P01' || attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
      }
    }
  } finally {
    await pool.end();
  }
}

export function parseLoadArgs(argv, usage, { defaultJobs = 4 } = {}) {
  const out = { sample: false, full: false, resume: false, jobs: defaultJobs, corpus: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--sample') out.sample = true;
    else if (a === '--resume') out.resume = true;
    else if (a === '--full') out.full = true;
    else if (a === '--corpus') out.corpus = argv[++i];
    else if (a === '--jobs') out.jobs = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      process.stdout.write(`${usage}\n`);
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(out.jobs) || out.jobs < 1 || out.jobs > 8) throw new Error('--jobs 1..8');
  if (out.sample && out.full) throw new Error('--sample and --full exclude each other');
  return out;
}

/**
 * Load a corpus of documents, people and need-to-know grants.
 *
 * `fixture` = {
 *   corpus        short name: ids file `<state>/<corpus>-ids.json`, personas `<corpus>-personas.txt`
 *   personasCorpus  optional: the personas file's name when several organizations share one
 *   keyPrefix     idempotency-key prefix, e.g. `erb-v1`
 *   company       { legal_name, kind? }
 *   people        [{ key, name, username, email, title, role, clearance, ceiling, persona? }]
 *   founder       key of the person the organization is bootstrapped with
 *   office        key of the person who ingests and grants (the records office)
 *   authorityReason(person) → string
 *   documents     [{ key, title, classification, artifactKind, mediaType, file, sha256, reason,
 *                    readers: [personKey], grantReason(person) → string,
 *                    derived?: { title, mediaType, file, sha256, reason, revisionLabel } }]
 * }
 *
 * A document with `derived` is ingested as its original (the record) and then as the text
 * extracted from it, which names the original through `derived_from` — the text is what KF
 * parses and indexes, as Véracier's PDFs do.
 */
export async function loadDocumentCorpus(fixture, opts) {
  const settings = stackSettings();
  const tally = new Tally();
  const idsFile = path.join(settings.state, `${fixture.corpus}-ids.json`);
  const personas = personasFile(fixture.personasCorpus ?? fixture.corpus);
  log(
    `${fixture.company.legal_name} (${fixture.corpus}) → ${settings.api} ` +
      `(${opts.mode}: ${fixture.documents.length} documents, ${fixture.people.length} people)`,
  );
  process.env.PGPASSWORD ??= 'dev-only-not-a-secret';
  const owner = ownerSession(REPO, settings.ownerUrl);
  const byKey = new Map(fixture.people.map((p) => [p.key, p]));
  const founder = byKey.get(fixture.founder);
  if (founder === undefined) throw new Error(`founder ${fixture.founder} is not in the overlay`);
  try {
    const boot = await bootstrapOrganization(owner, {
      legalName: fixture.company.legal_name,
      kind: fixture.company.kind ?? 'company',
      founder,
      people: fixture.people,
    });
    const { subjects, passwords } = await ensureAccounts(
      settings,
      fixture.people,
      personas,
      `${fixture.company.legal_name} fixture personas — local Keycloak passwords (fixtures/${fixture.corpus}).`,
    );
    const assignments = await grantAuthorities(owner, {
      people: fixture.people,
      founder,
      organizationId: boot.organizationId,
      personIds: boot.personIds,
      subjects,
      issuer: settings.oidc.issuer,
      reason: fixture.authorityReason,
    });
    const sessions = personaSessions(
      settings,
      fixture.people,
      passwords,
      boot.organizationId,
      assignments,
    );
    const ids = existsSync(idsFile) ? await readJson(idsFile) : { documents: {} };
    ids.corpus = fixture.corpus;
    ids.organizationId = boot.organizationId;
    ids.legalName = fixture.company.legal_name;
    ids.people = Object.fromEntries(
      fixture.people.map((p) => [
        p.key,
        {
          personId: boot.personIds[p.key],
          assignmentId: assignments[p.key],
          subject: subjects[p.key],
          username: p.username,
        },
      ]),
    );
    const save = () => writeFile(idsFile, `${JSON.stringify(ids, null, 2)}\n`, { mode: 0o600 });
    const office = sessions.get(fixture.office);
    try {
      const refused = await ingestDocuments(fixture, opts, office, ids, tally);
      await save();
      await needToKnow(fixture, opts, office, boot, ids, tally, byKey);
      if (refused.length > 0)
        log(`  ${refused.length} ingest refusal(s) above; they are reported, not retried`);
      await reindex(settings.state, [
        boot.organizationId,
        ...Object.values(boot.personIds),
        ...Object.values(assignments),
      ]);
    } finally {
      await save();
    }
    tally.print();
    log(`  organization ${boot.organizationId}; ids in ${idsFile}`);
    return { organizationId: boot.organizationId, idsFile, fresh: tally.fresh };
  } finally {
    await owner.end();
  }
}

/**
 * KF refuses, before storing a byte, content that must never enter it (credentials, bank
 * details, tax identifiers: `content_refused`). A corpus that holds such files — TheAgentCompany's
 * HR folder keeps passwords and social-security numbers — meets that refusal on every run; it is
 * the product working, so it is counted and named, not reported as a failure.
 */
function contentRefusal(error, doc, what, tally) {
  if (!(error instanceof ApiError) || error.body?.error !== 'content_refused') return false;
  tally.refuse(`refused by content rules (${what})`);
  log(`  content refused ${what} ${doc.key}: ${error.body.rule ?? error.body.message ?? ''}`);
  return true;
}

async function ingestDocuments(fixture, opts, office, ids, tally) {
  const total = fixture.documents.length;
  log(`== documents (POST /ingest as ${office.person.name}, ${total} documents)`);
  let done = 0;
  const pass = async (work, jobs) => {
    const refused = [];
    await mapLimit(work, jobs, async ({ doc, textOnly }) => {
      const failure = await ingestOne(fixture, office, ids, tally, doc, textOnly);
      if (failure !== undefined) refused.push({ doc, ...failure });
      done += 1;
      if (done % 1000 === 0) log(`  ${done}/${total}`);
    });
    return refused;
  };
  // Every write in an organization bumps its one retrieval band row, so two large documents
  // ingested at once can outwait the lock budget and the API answers 500. What failed in the
  // parallel pass is tried once more, one at a time (a replay costs nothing), and only what
  // fails twice is reported.
  // --resume: a large load that stopped part-way need not replay what the ids file already
  // records (a replay re-sends and re-parses the file); only the rest is ingested. A run without
  // it replays everything, which is the no-op proof.
  const recorded = (doc) => {
    const entry = ids.documents[doc.key];
    return (
      entry?.artifactId !== undefined &&
      (doc.derived === undefined || entry.textArtifactId !== undefined)
    );
  };
  const todo = opts.resume ? fixture.documents.filter((doc) => !recorded(doc)) : fixture.documents;
  if (opts.resume)
    log(
      `  --resume: ${fixture.documents.length - todo.length} already recorded, ${todo.length} to go`,
    );
  let refused = await pass(
    todo.map((doc) => ({ doc, textOnly: false })),
    opts.jobs,
  );
  if (refused.length > 0) {
    log(`  ${refused.length} failed in parallel; trying them again one at a time`);
    done -= refused.length;
    refused = await pass(
      refused.map((r) => ({ doc: r.doc, textOnly: r.what === 'text' })),
      1,
    );
  }
  for (const r of refused) log(`  REFUSED ${r.what} ${r.doc.key}: ${r.error}`);
  return refused;
}

/**
 * One document and its extracted text (`textOnly`: the text alone, its original already in):
 * undefined, or what failed and why.
 */
async function ingestOne(fixture, office, ids, tally, doc, textOnly = false) {
  const entry = (ids.documents[doc.key] ??= {});
  if (!textOnly) {
    try {
      const res = await office.request('POST', '/ingest', {
        title: doc.title,
        artifactKind: doc.artifactKind,
        classification: doc.classification,
        mediaType: doc.mediaType,
        contentBase64: (await readFile(doc.file)).toString('base64'),
        reason: doc.reason,
        idempotencyKey: `${fixture.keyPrefix}:doc:${doc.key}:${doc.sha256.slice(0, 16)}`,
      });
      entry.artifactId = res.body.artifactId;
      tally.add(doc.derived === undefined ? 'document' : 'document (original)', res.body.replayed);
    } catch (error) {
      if (contentRefusal(error, doc, 'original', tally)) return undefined;
      return { what: 'original', error: String(error.message ?? error) };
    }
  }
  if (doc.derived === undefined) return undefined;
  try {
    const res = await office.request('POST', '/ingest', {
      title: doc.derived.title,
      artifactKind: 'document',
      classification: doc.classification,
      mediaType: doc.derived.mediaType,
      contentBase64: (await readFile(doc.derived.file)).toString('base64'),
      derivedFrom: entry.artifactId,
      revisionLabel: doc.derived.revisionLabel,
      reason: doc.derived.reason,
      idempotencyKey: `${fixture.keyPrefix}:text:${doc.key}:${doc.derived.sha256.slice(0, 16)}`,
    });
    entry.textArtifactId = res.body.artifactId;
    tally.add('document (extracted text)', res.body.replayed);
  } catch (error) {
    if (contentRefusal(error, doc, 'text', tally)) return undefined;
    return { what: 'text', error: String(error.message ?? error) };
  }
  return undefined;
}

async function needToKnow(fixture, opts, office, boot, ids, tally, byKey) {
  const work = [];
  for (const doc of fixture.documents) {
    const entry = ids.documents[doc.key];
    if (entry === undefined) continue;
    for (const reader of doc.readers) {
      for (const [target, kind] of [
        [entry.artifactId, 'doc'],
        [entry.textArtifactId, 'text'],
      ]) {
        if (target !== undefined) work.push({ target, reader, kind, doc });
      }
    }
  }
  log(`== need-to-know (grant_access by ${office.person.name}, ${work.length} grants)`);
  await mapLimit(work, opts.jobs, async ({ target, reader, kind, doc }, index) => {
    const person = byKey.get(reader);
    await grantRead(
      office,
      target,
      boot.personIds[reader],
      doc.grantReason(person),
      `${fixture.keyPrefix}:grant:${kind}:${doc.key}:${reader}`,
      tally,
    );
    if ((index + 1) % 2000 === 0) log(`  ${index + 1}/${work.length}`);
  });
}
