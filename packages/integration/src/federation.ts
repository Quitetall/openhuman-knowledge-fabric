/**
 * Federation: citing what another system owns, without taking it over.
 *
 * `openhuman-quality` owns the controlled documents, requirements, hazards, controls and
 * protocols. `LamQuant` owns the decision records, specifications and benchmarks. Both have
 * their own review, their own tooling and their own people working in them.
 *
 * Copying that content here would create a second authority, and the second one is always
 * the one that drifts: six months on, two systems disagree about a hazard control and nobody
 * can say which is current. So this module records only what is needed to FIND a thing, CITE
 * it, and notice when it changes — identity, commit, path, digest.
 *
 * Three properties, each enforced rather than intended:
 *
 *   Read-only. There is no write path here, and `federated_source.writable` carries a CHECK
 *   pinning it false, so granting write access is a migration somebody reviews.
 *
 *   Pinned. References name a COMMIT, never a branch. A citation of `main` describes whatever
 *   that branch says today, and the audit question is always what it said when we approved it.
 *
 *   Verifiable. The digest is recorded as we saw it, so drift is detectable rather than
 *   merely worth worrying about.
 */

import { createHash } from 'node:crypto';
import type { Tx } from '@kf/database';

export interface FederatedReference {
  readonly id: string;
  readonly sourceId: string;
  readonly externalId: string;
  readonly commitSha: string;
  readonly path: string;
  readonly contentSha256: string;
  readonly title: string;
}

export interface ReferenceSpec {
  readonly sourceId: string;
  readonly externalId: string;
  readonly commitSha: string;
  readonly path: string;
  readonly title: string;
  readonly recordedBy: string;
}

export class FederationRejected extends Error {
  readonly reason: 'not_pinned' | 'unknown_source' | 'digest_mismatch' | 'missing';

  constructor(reason: FederationRejected['reason'], message: string) {
    super(message);
    this.name = 'FederationRejected';
    this.reason = reason;
  }
}

const COMMIT = /^[0-9a-f]{40}$/;

/** SHA-256 of the referenced bytes, exactly as they were read. */
export function digestOf(bytes: Buffer | string): string {
  return createHash('sha256')
    .update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes)
    .digest('hex');
}

/**
 * How the adapter reaches the other system.
 *
 * An interface rather than a git client, so the read path is substitutable and — more to the
 * point — so it is obvious there is no write path. Nothing here can change what it reads.
 */
export interface SourceReader {
  /** The bytes at a path, at a specific commit. Undefined if there is nothing there. */
  read(commitSha: string, path: string): Promise<Buffer | undefined>;
}

/**
 * Record a reference to something another system owns.
 *
 * The digest is computed HERE, from the bytes actually read, and never taken from the caller.
 * A digest supplied alongside the thing it describes proves nothing — the whole point is that
 * this system saw those bytes.
 */
export async function recordReference(
  tx: Tx,
  reader: SourceReader,
  spec: ReferenceSpec,
): Promise<FederatedReference> {
  if (!COMMIT.test(spec.commitSha)) {
    // A branch name would make the citation a moving target, and every decision resting on
    // it would silently change meaning.
    throw new FederationRejected(
      'not_pinned',
      `commit must be a full 40-character sha, got '${spec.commitSha}' — a branch is not a citation`,
    );
  }

  const source = await tx.maybeOne<{ id: string }>(
    'select id from quality.federated_source where id = $1',
    [spec.sourceId],
  );
  if (source === undefined) {
    throw new FederationRejected('unknown_source', `no federated source '${spec.sourceId}'`);
  }

  const bytes = await reader.read(spec.commitSha, spec.path);
  if (bytes === undefined) {
    throw new FederationRejected(
      'missing',
      `${spec.path} does not exist at ${spec.commitSha.slice(0, 12)} in ${spec.sourceId}`,
    );
  }

  const contentSha256 = digestOf(bytes);

  // Re-recording an existing reference must NOT quietly accept a different digest.
  //
  // The obvious upsert — on conflict, touch verified_at — keeps the digest already stored
  // and discards the one just computed. So a source whose history was rewritten would be
  // re-recorded as fine, the old digest would stay, and checkDrift would compare that old
  // digest against the new bytes forever without noticing. The upsert would have hidden
  // exactly the event this whole module exists to detect.
  const existing = await tx.maybeOne<{ id: string; content_sha256: string }>(
    `select id, content_sha256 from quality.federated_reference
      where source_id = $1 and external_id = $2 and commit_sha = $3`,
    [spec.sourceId, spec.externalId, spec.commitSha],
  );

  if (existing !== undefined) {
    if (existing.content_sha256 !== contentSha256) {
      throw new FederationRejected(
        'digest_mismatch',
        `${spec.path} at ${spec.commitSha.slice(0, 12)} now hashes to ${contentSha256.slice(0, 12)}, ` +
          `but was recorded as ${existing.content_sha256.slice(0, 12)}. Content cannot change at a ` +
          `pinned commit: the history was rewritten, or this is not the source it claims to be.`,
      );
    }
    await tx.query('update quality.federated_reference set verified_at = now() where id = $1', [
      existing.id,
    ]);
    return {
      id: existing.id,
      sourceId: spec.sourceId,
      externalId: spec.externalId,
      commitSha: spec.commitSha,
      path: spec.path,
      contentSha256,
      title: spec.title,
    };
  }

  const row = await tx.one<{ id: string }>(
    `insert into quality.federated_reference
       (source_id, external_id, commit_sha, path, content_sha256, title, recorded_by, verified_at)
     values ($1,$2,$3,$4,$5,$6,$7, now())
     returning id`,
    [
      spec.sourceId,
      spec.externalId,
      spec.commitSha,
      spec.path,
      contentSha256,
      spec.title,
      spec.recordedBy,
    ],
  );

  return {
    id: row.id,
    sourceId: spec.sourceId,
    externalId: spec.externalId,
    commitSha: spec.commitSha,
    path: spec.path,
    contentSha256,
    title: spec.title,
  };
}

export type DriftFinding =
  | { readonly referenceId: string; readonly problem: 'missing'; readonly detail: string }
  | {
      readonly referenceId: string;
      readonly problem: 'digest_mismatch';
      readonly detail: string;
      readonly recorded: string;
      readonly actual: string;
    };

/**
 * Re-read every reference and report what no longer matches.
 *
 * At a pinned commit this should never fire — git content is immutable at a sha — so a
 * finding here means something stronger than "the document changed": the history was
 * rewritten, or the object was garbage-collected, or the source is not what it claims to be.
 * That is exactly why the digest is worth recording even though the commit is pinned.
 */
export interface DriftReport {
  readonly findings: readonly DriftFinding[];
  /** How many references were actually re-read. */
  readonly checked: number;
  /** References skipped because no reader was supplied for their source. */
  readonly skipped: number;
  /** Which sources this run could see at all. */
  readonly sourcesChecked: readonly string[];
}

export async function checkDrift(
  tx: Tx,
  readers: ReadonlyMap<string, SourceReader>,
): Promise<DriftReport> {
  const references = await tx.query<{
    id: string;
    source_id: string;
    commit_sha: string;
    path: string;
    content_sha256: string;
  }>(
    `select id, source_id, commit_sha, path, content_sha256
       from quality.federated_reference order by source_id, external_id, commit_sha`,
  );

  const findings: DriftFinding[] = [];
  let checked = 0;
  let skipped = 0;
  for (const ref of references) {
    const reader = readers.get(ref.source_id);
    // A source with no reader is not checked, and MUST NOT read as clean. A scheduled job
    // that lost a credential would otherwise report a healthy federation every night while
    // checking none of it, which is the failure mode monitoring exists to catch — so the
    // count comes back with the findings rather than being inferred from stale timestamps.
    if (reader === undefined) {
      skipped += 1;
      continue;
    }
    checked += 1;

    const bytes = await reader.read(ref.commit_sha, ref.path);
    if (bytes === undefined) {
      findings.push({
        referenceId: ref.id,
        problem: 'missing',
        detail: `${ref.path} is gone at ${ref.commit_sha.slice(0, 12)}`,
      });
      continue;
    }
    const actual = digestOf(bytes);
    if (actual !== ref.content_sha256) {
      findings.push({
        referenceId: ref.id,
        problem: 'digest_mismatch',
        detail: `${ref.path} at ${ref.commit_sha.slice(0, 12)} no longer hashes to what was recorded`,
        recorded: ref.content_sha256,
        actual,
      });
      continue;
    }
    await tx.query('update quality.federated_reference set verified_at = now() where id = $1', [
      ref.id,
    ]);
  }
  // Deliberately: a drifting reference does NOT get its verified_at touched, so it keeps
  // being reported every run. A finding that stops appearing because somebody saw it once is
  // worse than a noisy one.
  return { findings, checked, skipped, sourcesChecked: [...readers.keys()].sort() };
}

/** Link a Fabric object to something another system owns. */
export async function linkToReference(
  tx: Tx,
  link: {
    readonly objectId: string;
    readonly referenceId: string;
    readonly linkKind:
      'governed_by' | 'satisfies' | 'verifies' | 'mitigates' | 'implements' | 'cites';
    readonly createdBy: string;
    readonly authorizingAction?: string;
  },
): Promise<{ id: string; alreadyLinked: boolean }> {
  const created = await tx.maybeOne<{ id: string }>(
    `insert into quality.federated_link
       (object_id, reference_id, link_kind, created_by, authorizing_action)
     values ($1,$2,$3,$4,$5)
     on conflict (object_id, reference_id, link_kind) do nothing
     returning id`,
    [
      link.objectId,
      link.referenceId,
      link.linkKind,
      link.createdBy,
      link.authorizingAction ?? null,
    ],
  );
  if (created !== undefined) return { id: created.id, alreadyLinked: false };

  // DO NOTHING rather than a self-assigning DO UPDATE. The upsert form wrote `link_kind`
  // back to itself — a no-op dressed as a write — so the caller could not tell whether the
  // link was made just now or years ago by somebody else.
  const existing = await tx.one<{ id: string }>(
    `select id from quality.federated_link
      where object_id = $1 and reference_id = $2 and link_kind = $3`,
    [link.objectId, link.referenceId, link.linkKind],
  );
  return { id: existing.id, alreadyLinked: true };
}

/**
 * An in-memory source, for tests and for reading a checkout that is already on disk.
 *
 * Read-only by construction: there is no method here that writes, which is the same guarantee
 * the real adapter gives and the reason the interface is this narrow.
 */
export class StaticSourceReader implements SourceReader {
  readonly #content: Map<string, Buffer>;

  constructor(entries: Iterable<readonly [string, Buffer | string]> = []) {
    this.#content = new Map(
      [...entries].map(([k, v]) => [k, typeof v === 'string' ? Buffer.from(v, 'utf8') : v]),
    );
  }

  async read(commitSha: string, path: string): Promise<Buffer | undefined> {
    return this.#content.get(`${commitSha}:${path}`);
  }

  /** Test-only: change what a commit appears to contain, simulating a rewritten history. */
  rewrite(commitSha: string, path: string, content: Buffer | string): void {
    this.#content.set(
      `${commitSha}:${path}`,
      typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
    );
  }

  forget(commitSha: string, path: string): void {
    this.#content.delete(`${commitSha}:${path}`);
  }
}
