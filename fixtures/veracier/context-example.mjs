#!/usr/bin/env node
/* global fetch */
// Context compilation for one benchmark question, through KF's governed path, as the person asking.
//
//   node fixtures/veracier/context-example.mjs [--question QUAL-01] [--as <person key>]
//        [--compare <person key>] [--budget 6000] [--k 10]
//
// Every step is a request to the running API as that person, signed in through the realm, so
// every step is under their grants: nothing here reads the database or the engine directly.
//
//   1. `GET /search?q=<question>` — the composed answer; its `semantic` list is the retrieval
//      engine's ranking, scored under the person's mask and re-checked by KF before it is served.
//      No semantic list (the engine is absent or refused) is a refusal here, not a lexical fallback.
//   2. `GET /master-record/projections/agent_context?token_budget=N` — the person's agent-context
//      projection (SAS §32/§59): the members of their master record, the exact set they are
//      permitted to read. A missing or stale master record is compiled first
//      (`POST /master-record/compile`, the person's own act, as the web application does).
//   3. The package: semantic hits in rank order that are members of that projection, each one's
//      text read through `GET /documents/:id/source` as the person, until the token budget.
//
// Then two checks, each able to fail: every source in the package is a member of the person's
// agent_context, and every source is a document the fixture's overlay says the person may read
// (an independent statement of the grants: clearance, organization-wide ceiling, need-to-know
// readers). With `--compare`, the same question is compiled for a second person and the sources
// one has and the other does not are listed.
//
// The package (with document text) is written 0600 under the fixture's state directory, never into
// the repository; stdout carries identifiers, titles, digests and the checks only.
//
// This is the KF half of LAMU context compilation: LAMU's `KfSource` adapter
// (lamu-api/src/context_kf.rs) expects `POST /context-source/retrieve` and
// `POST /context-source/read` on the API, which KF does not serve yet. This script is what those
// two routes would do, done with the routes KF has.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PersonaSession } from './lib/kf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RANK = { public: 0, internal: 1, confidential: 2, restricted: 3 };

function parseArgs(argv) {
  const out = {
    question: 'QUAL-01',
    as: undefined,
    compare: 'youssef.amrani',
    budget: 6000,
    k: 10,
    corpus: process.env.KF_VERACIER_CORPUS ?? '/mnt/4tb/data/veracier',
    state: process.env.KF_VERACIER_STATE ?? path.join(homedir(), '.local', 'state', 'kf-veracier'),
    personas:
      process.env.KF_VERACIER_PERSONAS ??
      path.join(homedir(), '.config', 'kf', 'veracier-personas.txt'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--question') out.question = argv[++i];
    else if (a === '--as') out.as = argv[++i];
    else if (a === '--compare') out.compare = argv[++i] === 'none' ? undefined : argv[i];
    else if (a === '--budget') out.budget = Number(argv[++i]);
    else if (a === '--k') out.k = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(out.budget) || out.budget < 256) throw new Error('--budget >= 256');
  if (!Number.isInteger(out.k) || out.k < 1 || out.k > 50) throw new Error('--k 1..50');
  return out;
}

/** A declared estimate, not a tokenizer count: four characters per token. */
const estimateTokens = (text) => Math.ceil(text.length / 4);
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

async function agentContext(session, budget) {
  const route = `/master-record/projections/agent_context?token_budget=${budget}`;
  try {
    return (await session.request('GET', route)).body;
  } catch (error) {
    if (error.status !== 404 && error.status !== 409) throw error;
    // The person's own act, exactly as the web application performs it on a stale record.
    await session.request('POST', '/master-record/compile', {
      idempotencyKey: `veracier-context-example-${Date.now()}`,
      reason: 'context compilation example',
    });
    return (await session.request('GET', route)).body;
  }
}

async function readText(session, objectId) {
  const response = await fetch(`${session.apiOrigin}/documents/${objectId}/source`, {
    headers: {
      authorization: `Bearer ${await session.token()}`,
      'x-kf-organization': session.organizationId,
      'x-kf-acting-role': session.assignmentId,
      'x-kf-classification': session.person.clearance,
    },
  });
  if (!response.ok) return { status: response.status };
  const type = response.headers.get('content-type') ?? '';
  if (!type.startsWith('text/')) return { status: response.status, type };
  return { status: response.status, type, text: await response.text() };
}

async function compile(ctx, person, question) {
  const session = ctx.sessionOf(person);
  const search = (
    await session.request('GET', `/search?q=${encodeURIComponent(question)}&limit=${ctx.opts.k}`)
  ).body;
  if (search.semantic === undefined) {
    return {
      refused: `no semantic ranking: ${(search.withheld ?? []).map((w) => w.reason).join('; ')}`,
    };
  }
  const projection = await agentContext(session, ctx.opts.budget);
  const members = new Map(
    projection.sections.flatMap((section) => section.members.map((m) => [m.objectId, m])),
  );

  const sources = [];
  const chunks = [];
  let tokens = estimateTokens(question) + 64; // the task and the framing
  // Every semantic hit goes in, in rank order: KF already governed the list. The checks below
  // then test it independently, so they can fail.
  for (const hit of search.semantic.hits) {
    const read = await readText(session, hit.objectId);
    const body = read.text ?? hit.title;
    const room = ctx.opts.budget - tokens;
    if (room <= 64) break;
    const text = estimateTokens(body) > room ? body.slice(0, room * 4) : body;
    tokens += estimateTokens(text) + 16;
    sources.push({
      rank: hit.rank,
      score: Number(hit.score.toFixed(4)),
      objectId: hit.objectId,
      docId: ctx.docOfArtifact.get(hit.objectId) ?? null,
      title: hit.title,
      classification: hit.classification,
      read:
        read.text === undefined ? `title only (${read.status} ${read.type ?? ''})`.trim() : 'text',
      truncated: text.length < body.length,
      sha256: sha256(text),
      estTokens: estimateTokens(text),
    });
    chunks.push(`<source object="${hit.objectId}" title="${hit.title}">\n${text}\n</source>`);
  }

  // Check 1: every source is a member of the person's agent_context.
  const outsideProjection = sources.filter((s) => !members.has(s.objectId));
  // Check 2: every source is a document the overlay says this person may read.
  // A source that is a governed record rather than a document has no overlay row; it is held to
  // check 1 alone, and counted.
  const unreadable = sources.filter((s) => {
    if (s.docId === null) return false;
    const doc = ctx.byDoc.get(s.docId);
    return doc === undefined || !ctx.mayRead(person, doc);
  });
  return {
    persona: { key: person.key, name: person.name, clearance: person.clearance },
    semanticRanking: search.semantic.ranking,
    agentContext: {
      projectionMembers: members.size,
      corpusDigest: projection.source.corpusDigest,
    },
    estTokens: tokens,
    sources,
    checks: {
      allInAgentContext: outsideProjection.length === 0,
      allReadableByOverlay: unreadable.length === 0,
      unreadable: unreadable.map((s) => s.objectId),
      notDocuments: sources.filter((s) => s.docId === null).length,
    },
    text: chunks.join('\n\n'),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const overlay = path.join(HERE, 'overlay');
  const people = JSON.parse(await readFile(path.join(overlay, 'people.json'), 'utf8'));
  const documents = JSON.parse(await readFile(path.join(overlay, 'documents.json'), 'utf8'));
  const ids = JSON.parse(await readFile(path.join(opts.state, 'veracier-ids.json'), 'utf8'));
  const answers = JSON.parse(await readFile(path.join(opts.corpus, 'ANSWER_KEY.json'), 'utf8'));
  const passwords = new Map(
    (await readFile(opts.personas, 'utf8'))
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'))
      .map((l) => l.split('\t').slice(0, 2)),
  );
  const spec = answers[opts.question];
  if (spec === undefined) throw new Error(`no question ${opts.question} in ANSWER_KEY.json`);
  const asker =
    opts.as === undefined
      ? people.find((p) => p.asker === spec.asker)
      : people.find((p) => p.key === opts.as || p.username === opts.as);
  if (asker === undefined) throw new Error('no such person');

  const docOfArtifact = new Map();
  for (const [docId, entry] of Object.entries(ids.documents)) {
    if (entry.artifactId) docOfArtifact.set(entry.artifactId, docId);
    if (entry.textArtifactId) docOfArtifact.set(entry.textArtifactId, docId);
  }
  const oidc = {
    issuer: `${process.env.KF_VERACIER_KEYCLOAK ?? 'http://localhost:18080'}/realms/knowledge-fabric`,
    clientId: 'knowledge-fabric-web',
    redirectUri: `http://localhost:${process.env.KF_VERACIER_WEB_PORT ?? '3100'}/auth/callback`,
  };
  const apiOrigin = `http://127.0.0.1:${process.env.KF_VERACIER_API_PORT ?? '4100'}`;
  const sessions = new Map();
  const ctx = {
    opts,
    docOfArtifact,
    byDoc: new Map(documents.map((d) => [d.doc_id, d])),
    mayRead: (person, doc) =>
      RANK[doc.classification] <= RANK[person.clearance] &&
      (RANK[doc.classification] <= RANK[person.ceiling] || doc.readers.includes(person.key)),
    sessionOf: (person) => {
      if (!sessions.has(person.key)) {
        sessions.set(
          person.key,
          new PersonaSession({
            oidc,
            apiOrigin,
            person,
            password: passwords.get(person.username),
            organizationId: ids.organizationId,
            assignmentId: ids.people[person.key].assignmentId,
          }),
        );
      }
      return sessions.get(person.key);
    },
  };

  const packages = [await compile(ctx, asker, spec.question)];
  const other =
    opts.compare === undefined
      ? undefined
      : people.find((p) => p.key === opts.compare || p.username === opts.compare);
  if (other !== undefined && other.key !== asker.key) {
    packages.push(await compile(ctx, other, spec.question));
  }

  const outDir = path.join(opts.state, 'context-examples');
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const outFile = path.join(outDir, `${opts.question}.json`);
  await writeFile(
    outFile,
    `${JSON.stringify({ question: opts.question, text: spec.question, packages }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const summary = {
    question: opts.question,
    packages: packages.map(({ text, ...rest }) => ({ ...rest, textChars: text?.length ?? 0 })),
    package_file: outFile,
  };
  if (packages.length === 2 && packages.every((p) => p.sources !== undefined)) {
    const [a, b] = packages.map((p) => new Set(p.sources.map((s) => s.objectId)));
    summary.onlyFirst = packages[0].sources.filter((s) => !b.has(s.objectId)).map((s) => s.title);
    summary.onlySecond = packages[1].sources.filter((s) => !a.has(s.objectId)).map((s) => s.title);
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  const failed = packages.some(
    (p) =>
      p.checks !== undefined && (!p.checks.allInAgentContext || !p.checks.allReadableByOverlay),
  );
  if (failed) process.exitCode = 3;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
