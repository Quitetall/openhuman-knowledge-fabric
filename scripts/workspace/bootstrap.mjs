/* global fetch */
// The first person of a workspace, and their files, through the paths the fixtures use.
//
//   organization and person   `kf bootstrap-organization` (fixtures/lib/loader.mjs)
//   sign-in account           Keycloak admin API (fixtures/lib/keycloak.mjs ensureUser), on the
//                             loopback Keycloak only; the password is the caller's, sent once in
//                             the reset-password request body and nowhere else
//   authority                 `kf grant-authority`: technical_authority as the founding grant,
//                             with the identity link, cleared to confidential (plan.mjs
//                             FOUNDER_AUTHORITY says why that role)
//   files                     POST /ingest as that person, one act per file, after the ingest
//                             planner's deny list and content scan; a PDF or another format KF does
//                             not parse is followed by its extracted text (`derived_from`), as the
//                             fixtures load theirs
//
// This module imports @kf/database through fixtures/lib/kf.mjs, so it is loaded only once the
// stack has been built (engine.mjs imports it lazily).

import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { adminToken, ensureUser } from '../../fixtures/lib/keycloak.mjs';
import { ApiError, PersonaSession, ownerSession } from '../../fixtures/lib/kf.mjs';
import { bootstrapOrganization, grantAuthorities, reindex } from '../../fixtures/lib/loader.mjs';
import { extract, plan as extractionPlan } from '../../fixtures/lib/extract-text.mjs';
import { fitTitle } from '../../fixtures/lib/file-corpus.mjs';
import { FOUNDER_AUTHORITY, IMPORT_CEILING, WorkspaceError } from './plan.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const REALM = 'knowledge-fabric';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function founderOf(identity) {
  return {
    key: 'founder',
    name: identity.name,
    username: identity.username,
    email: identity.email,
    title: 'Founder',
    role: FOUNDER_AUTHORITY.roles[0],
    clearance: FOUNDER_AUTHORITY.clearance,
    ceiling: FOUNDER_AUTHORITY.clearance,
  };
}

async function liveAssignment(owner, organizationId, personId, role) {
  const row = (
    await owner.scoped(
      organizationId,
      `select id from org.role_assignment
        where subject_id = $1 and scope_id = $2 and role_id = $3
          and valid_from <= now() and (valid_to is null or valid_to > now())
        order by valid_from desc limit 1`,
      [personId, organizationId, role],
    )
  )[0];
  if (row === undefined) throw new Error(`no live ${role} assignment`);
  return row.id;
}

/**
 * Organization, person, account and authority. Idempotent: each step reuses what exists, so an
 * interrupted first run is completed by the next. `password` is the account's password, set
 * only when the account is created.
 */
export async function bootstrapWorkspace({ settings, identity, password, step }) {
  process.env.PGPASSWORD ??= 'dev-only-not-a-secret';
  const owner = ownerSession(REPO, settings.ownerUrl);
  const founder = founderOf(identity);
  try {
    step('organization', `Creating ${identity.organization}`);
    const boot = await bootstrapOrganization(owner, {
      legalName: identity.organization,
      kind: 'company',
      founder,
      people: [founder],
    });
    const personId = boot.personIds.founder;

    step('account', `Creating the sign-in for ${identity.username}`);
    const kcPassword = (
      await readFile(path.join(settings.state, 'keycloak-admin-password'), 'utf8')
    ).trim();
    const token = await adminToken(settings.keycloak, kcPassword);
    const account = await ensureUser(settings.keycloak, REALM, token, founder, password);

    step('authority', 'Giving you the authority to run it');
    const reason = (role) =>
      `Workspace founder (scripts/workspace): ${identity.name} founded ${identity.organization} ` +
      `on this computer and acts as ${role}, cleared to ${founder.clearance}`;
    const assignments = {};
    assignments[founder.role] = (
      await grantAuthorities(owner, {
        people: [founder],
        founder,
        organizationId: boot.organizationId,
        personIds: boot.personIds,
        subjects: { founder: account.subject },
        issuer: settings.oidc.issuer,
        reason: () => reason(founder.role),
      })
    ).founder;
    for (const role of FOUNDER_AUTHORITY.roles.slice(1)) {
      await owner.kf([
        'grant-authority',
        '--person',
        personId,
        '--organization',
        boot.organizationId,
        '--role',
        role,
        '--clearance',
        founder.clearance,
        '--granted-by',
        personId,
        '--reason',
        reason(role),
      ]);
      assignments[role] = await liveAssignment(owner, boot.organizationId, personId, role);
    }
    await reindex(settings.state, [boot.organizationId, personId, ...Object.values(assignments)]);
    return {
      organizationId: boot.organizationId,
      personId,
      subject: account.subject,
      accountCreated: account.created,
      assignments,
    };
  } finally {
    await owner.end();
  }
}

/** Keycloak asks for a new password at the next sign-in (the generated-password path only). */
export async function requirePasswordChange({ settings, subject }) {
  const kcPassword = (
    await readFile(path.join(settings.state, 'keycloak-admin-password'), 'utf8')
  ).trim();
  const token = await adminToken(settings.keycloak, kcPassword);
  const url = `${settings.keycloak}/admin/realms/${REALM}/users/${subject}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const user = await (await fetch(url, { headers })).json();
  const response = await fetch(url, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ ...user, requiredActions: ['UPDATE_PASSWORD'] }),
  });
  if (response.status !== 204) throw new Error(`requiring a new password: HTTP ${response.status}`);
}

/**
 * Make the organization's provider ceiling `ceiling` (`none` or `internal`, from answers.mjs
 * ceilingFor), as the founder's own `set_model_routing_policy` act, when what is in force differs.
 * Returns what it did, in a word for the log.
 */
export async function alignModelRouting({ session, ceiling }) {
  if (ceiling !== 'none' && ceiling !== 'internal') {
    throw new Error(`refusing a provider ceiling of ${ceiling}`);
  }
  const inForce = (await session.request('GET', '/model-routing')).body?.providerCeiling;
  if (inForce === ceiling) return `already ${ceiling}`;
  await session.act('set_model_routing_policy', {
    targetIds: [session.organizationId],
    payload: { provider_ceiling: ceiling },
    reason:
      ceiling === 'none'
        ? 'Workspace setup: answers are written on this computer only, so nothing leaves it'
        : 'Workspace setup: a cloud model may answer from records cleared to leave (public, internal)',
    idempotencyKey: `workspace-routing-${session.organizationId}-${ceiling}`,
  });
  return `set to ${ceiling}`;
}

export function sessionFor({ settings, identity, record, password }) {
  return new PersonaSession({
    oidc: settings.oidc,
    apiOrigin: settings.api,
    person: founderOf(identity),
    password,
    organizationId: record.organizationId,
    assignmentId: record.assignments[FOUNDER_AUTHORITY.roles[0]],
  });
}

/** Every regular file under `root`; a dot-entry is reported as one refusal and never entered. */
async function walk(root, rel = '', out = { files: [], hidden: [], other: [] }) {
  for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const relPath = path.join(rel, entry.name);
    if (entry.name.startsWith('.')) out.hidden.push(relPath);
    else if (entry.isDirectory()) await walk(root, relPath, out);
    else if (entry.isFile()) out.files.push(relPath);
    else out.other.push(relPath);
  }
  return out;
}

async function ingestPlanner() {
  const dist = path.join(REPO, 'apps', 'api', 'dist', 'ingest');
  const planner = await import(pathToFileURL(path.join(dist, 'plan.js')).href);
  const policy = await import(pathToFileURL(path.join(dist, 'content-policy.js')).href);
  return { ...planner, ...policy };
}

function refusalCode(error) {
  if (error instanceof ApiError) {
    const rule = error.body?.rule ?? error.body?.ruleId;
    return [error.body?.error ?? `http_${error.status}`, rule].filter(Boolean).join(':');
  }
  return 'error';
}

/**
 * Import a folder as the person whose `session` this is. Returns counts and every refusal with
 * its code; a refused file is skipped, never retried, and nothing else stops.
 */
export async function importFolder({ session, folder, step }) {
  const root = path.resolve(folder);
  const stat = await lstat(root).catch(() => undefined);
  if (stat === undefined || !stat.isDirectory()) {
    throw new WorkspaceError(
      'import_not_a_folder',
      `There is no folder at ${root}.`,
      'Check the path and try again.',
    );
  }
  const found = await walk(root);
  if (found.files.length > IMPORT_CEILING) {
    throw new WorkspaceError(
      'import_too_large',
      `That folder holds ${found.files.length} files; one import takes at most ${IMPORT_CEILING}.`,
      'Import its sub-folders one at a time.',
    );
  }
  const planner = await ingestPlanner();
  const result = { ingested: 0, replayed: 0, extractedText: 0, refused: [] };
  const refuse = (file, code) => result.refused.push({ path: file, code });
  for (const file of found.hidden) refuse(file, 'deny_list:hidden-entry');
  for (const file of found.other) refuse(file, 'not_a_regular_file');
  let done = 0;
  for (const rel of found.files.sort()) {
    done += 1;
    step('import', `Adding your files (${done} of ${found.files.length})`);
    const referenceOnly = planner.referenceOnlyRuleFor(rel);
    if (referenceOnly !== undefined) {
      refuse(rel, `reference_only:${referenceOnly.ruleId}`);
      continue;
    }
    const denied = planner.deniedPathRule(rel);
    if (denied !== undefined) {
      refuse(rel, `deny_list:${denied.ruleId}`);
      continue;
    }
    const bytes = await readFile(path.join(root, rel));
    if (bytes.length === 0) {
      refuse(rel, 'empty_file');
      continue;
    }
    const scanned = planner.scanContent(rel, bytes);
    if (scanned !== undefined) {
      refuse(rel, `content_refused:${scanned.ruleId}`);
      continue;
    }
    const extraction = extractionPlan(rel);
    const digest = sha256(bytes);
    const pathKey = sha256(Buffer.from(rel)).slice(0, 16);
    let artifactId;
    try {
      const res = await session.request('POST', '/ingest', {
        title: fitTitle(rel),
        artifactKind: planner.artifactKindFor(rel),
        classification: FOUNDER_AUTHORITY.importClassification,
        mediaType: extraction.supported ? extraction.mediaType : planner.mediaTypeFor(rel),
        contentBase64: bytes.toString('base64'),
        reason: `Imported from the founder's folder ${path.basename(root)} (scripts/workspace)`,
        idempotencyKey: `kf-local:import:${pathKey}:${digest.slice(0, 16)}`,
      });
      artifactId = res.body.artifactId;
      result[res.body.replayed ? 'replayed' : 'ingested'] += 1;
    } catch (error) {
      refuse(rel, refusalCode(error));
      continue;
    }
    if (!extraction.supported || !extraction.needsText) continue;
    let text;
    try {
      text = (await extract(path.join(root, rel))).text;
    } catch {
      refuse(`${rel} (text)`, 'text_not_extracted');
      continue;
    }
    const body = Buffer.from(text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    try {
      await session.request('POST', '/ingest', {
        title: fitTitle(rel, ' — extracted text'),
        artifactKind: 'document',
        classification: FOUNDER_AUTHORITY.importClassification,
        mediaType: 'text/markdown',
        contentBase64: body.toString('base64'),
        derivedFrom: artifactId,
        revisionLabel: 'extracted:text',
        reason: `Text extracted from ${rel} by fixtures/lib/extract-text.mjs; the original remains the record`,
        idempotencyKey: `kf-local:text:${pathKey}:${sha256(body).slice(0, 16)}`,
      });
      result.extractedText += 1;
    } catch (error) {
      refuse(`${rel} (text)`, refusalCode(error));
    }
  }
  return result;
}

export function importSummary(result) {
  const byCode = new Map();
  for (const r of result.refused) byCode.set(r.code, (byCode.get(r.code) ?? 0) + 1);
  const codes = [...byCode].map(([code, n]) => `${code} ${n}`).join(', ');
  return (
    `${result.ingested} added, ${result.replayed} already there, ` +
    `${result.extractedText} with extracted text, ${result.refused.length} refused` +
    (codes === '' ? '' : ` (${codes})`)
  );
}
