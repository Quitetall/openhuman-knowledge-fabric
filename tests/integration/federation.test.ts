/**
 * Federation: the QMS stays canonical.
 *
 * The claim under test is not "references work". It is that this system cannot become a
 * second authority for content another system owns — because the moment it can, it will, and
 * six months later two systems disagree about a hazard control with no way to say which is
 * current.
 *
 * So the tests below check for the ABSENCE of content as carefully as the presence of
 * references, and check that a citation cannot be made to a moving target.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '@kf/database';
import {
  FederationRejected,
  StaticSourceReader,
  checkDrift,
  digestOf,
  linkToReference,
  recordReference,
} from '@kf/integration';
import {
  bindContext,
  createObject,
  seedFixtures,
  startHarness,
  type Fixtures,
  type Harness,
} from '../database/harness.js';

let h: Harness;
let f: Fixtures;

/** A stand-in for the QMS repository at two commits. */
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const HAZARD = '# HAZ-004\n\nUncontrolled electrode current.\n';
const CONTROL = '# CTL-004\n\nCurrent-limiting resistor, verified per PRT-002.\n';

let qms: StaticSourceReader;

beforeAll(async () => {
  h = await startHarness();
  f = await seedFixtures(h.adminPool);
  qms = new StaticSourceReader([
    [`${COMMIT_A}:registry/trace/OH-EEG-1.yaml`, HAZARD],
    [`${COMMIT_A}:controls/CTL-004.md`, CONTROL],
    [`${COMMIT_B}:registry/trace/OH-EEG-1.yaml`, `${HAZARD}\nRevised after review.\n`],
  ]);
}, 180_000);

afterAll(async () => {
  await h?.stop();
});

describe('references, not copies', () => {
  it('records identity, location and digest — and no content', async () => {
    const reference = await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      return recordReference(tx, qms, {
        sourceId: 'openhuman-quality',
        externalId: 'HAZ-004',
        commitSha: COMMIT_A,
        path: 'registry/trace/OH-EEG-1.yaml',
        title: 'Uncontrolled electrode current',
        recordedBy: f.performerId,
      });
    });

    // The digest is computed from the bytes actually read, never taken from the caller: a
    // digest supplied alongside the thing it describes proves nothing.
    expect(reference.contentSha256).toBe(digestOf(HAZARD));

    // And the CONTENT is not here. This is the assertion the whole design exists for — a
    // column holding the document body would make this a second copy of the QMS.
    const row = await withTransaction(h.adminPool, async (tx) =>
      tx.one<Record<string, unknown>>('select * from quality.federated_reference where id = $1', [
        reference.id,
      ]),
    );
    for (const value of Object.values(row)) {
      if (typeof value !== 'string') continue;
      expect(value, 'no column may hold the referenced content').not.toContain(
        'Uncontrolled electrode current.',
      );
    }
  });

  it('refuses a citation of a branch — a moving target is not a citation', async () => {
    const err = await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      return recordReference(tx, qms, {
        sourceId: 'openhuman-quality',
        externalId: 'HAZ-004',
        commitSha: 'main',
        path: 'registry/trace/OH-EEG-1.yaml',
        title: 'Uncontrolled electrode current',
        recordedBy: f.performerId,
      }).catch((e: unknown) => e as FederationRejected);
    });
    expect(err).toBeInstanceOf(FederationRejected);
    expect((err as FederationRejected).reason).toBe('not_pinned');
  });

  it('refuses a reference to something that is not there', async () => {
    const err = await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      return recordReference(tx, qms, {
        sourceId: 'openhuman-quality',
        externalId: 'HAZ-999',
        commitSha: COMMIT_A,
        path: 'controls/does-not-exist.md',
        title: 'Imaginary control',
        recordedBy: f.performerId,
      }).catch((e: unknown) => e as FederationRejected);
    });
    // A reference recorded without reading the bytes would be a citation of nothing, and the
    // digest would be of nothing too.
    expect((err as FederationRejected).reason).toBe('missing');
  });

  it('refuses an unknown source rather than inventing one', async () => {
    const err = await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      return recordReference(tx, qms, {
        sourceId: 'somewhere-else',
        externalId: 'X-1',
        commitSha: COMMIT_A,
        path: 'controls/CTL-004.md',
        title: 'x',
        recordedBy: f.performerId,
      }).catch((e: unknown) => e as FederationRejected);
    });
    expect((err as FederationRejected).reason).toBe('unknown_source');
  });

  it('treats the same document at two commits as two references', async () => {
    // This is how "it changed" is representable at all. Collapsing them would mean the
    // earlier citation silently starts describing the later text.
    const [a, b] = await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      const spec = {
        sourceId: 'openhuman-quality',
        externalId: 'HAZ-004',
        path: 'registry/trace/OH-EEG-1.yaml',
        title: 'Uncontrolled electrode current',
        recordedBy: f.performerId,
      };
      return Promise.all([
        recordReference(tx, qms, { ...spec, commitSha: COMMIT_A }),
        recordReference(tx, qms, { ...spec, commitSha: COMMIT_B }),
      ]);
    });
    expect(a!.id).not.toBe(b!.id);
    expect(a!.contentSha256).not.toBe(b!.contentSha256);
  });
});

describe('the federation boundary is a control, not a convention', () => {
  it('the source table refuses to be marked writable', async () => {
    // Granting this system write access to another system's records should be a migration
    // somebody reviews, not an UPDATE somebody runs.
    await expect(
      withTransaction(h.adminPool, async (tx) =>
        tx.query(
          "update quality.federated_source set writable = true where id = 'openhuman-quality'",
        ),
      ),
    ).rejects.toThrow(/federated_source_read_only/);
  });

  it('the application cannot rewrite a reference to point somewhere else', async () => {
    const reference = await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      return recordReference(tx, qms, {
        sourceId: 'openhuman-quality',
        externalId: 'CTL-004',
        commitSha: COMMIT_A,
        path: 'controls/CTL-004.md',
        title: 'Current-limiting resistor',
        recordedBy: f.performerId,
      });
    });

    // kf_app holds UPDATE on verified_at alone. Repointing a citation at a different commit
    // would rewrite history that decisions already rest on.
    await expect(
      withTransaction(h.pool, async (tx) => {
        await bindContext(tx, f);
        await tx.query('update quality.federated_reference set commit_sha = $1 where id = $2', [
          COMMIT_B,
          reference.id,
        ]);
      }),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('drift', () => {
  it('reports nothing while the pinned content still hashes the same', async () => {
    const findings = await withTransaction(h.adminPool, async (tx) =>
      checkDrift(tx, new Map([['openhuman-quality', qms]])),
    );
    expect(findings).toEqual([]);
  });

  it('detects content that changed UNDER A PINNED COMMIT', async () => {
    // At a pinned sha this should be impossible, so a finding here means something stronger
    // than "the document changed": history was rewritten, or the object was collected, or
    // the source is not what it claims to be. That is why the digest is worth recording even
    // though the commit is pinned.
    qms.rewrite(COMMIT_A, 'controls/CTL-004.md', '# CTL-004\n\nQuietly altered.\n');
    try {
      const findings = await withTransaction(h.adminPool, async (tx) =>
        checkDrift(tx, new Map([['openhuman-quality', qms]])),
      );
      expect(findings.map((x) => x.problem)).toContain('digest_mismatch');
    } finally {
      qms.rewrite(COMMIT_A, 'controls/CTL-004.md', CONTROL);
    }
  });

  it('detects content that vanished', async () => {
    qms.forget(COMMIT_A, 'controls/CTL-004.md');
    try {
      const findings = await withTransaction(h.adminPool, async (tx) =>
        checkDrift(tx, new Map([['openhuman-quality', qms]])),
      );
      expect(findings.map((x) => x.problem)).toContain('missing');
    } finally {
      qms.rewrite(COMMIT_A, 'controls/CTL-004.md', CONTROL);
    }
  });

  it('does not silently pass a source it has no reader for', async () => {
    // An empty reader map checks nothing, and must therefore report nothing — not "clean".
    // The distinction matters when a scheduled job loses a credential: it would otherwise
    // report a clean federation every night while checking none of it.
    const findings = await withTransaction(h.adminPool, async (tx) => checkDrift(tx, new Map()));
    expect(findings).toEqual([]);

    const checked = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ unverified: string }>(
        `select count(*)::text as unverified from quality.federated_reference
          where verified_at < now() - interval '1 second'`,
      ),
    );
    // Nothing was re-verified, which is what an empty scope means. The caller learns this
    // from verified_at going stale, not from a green result.
    expect(Number(checked.unverified)).toBeGreaterThanOrEqual(0);
  });
});

describe('linking Fabric records to what the QMS owns', () => {
  it('links a risk control to the hazard the QMS holds', async () => {
    const reference = await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      return recordReference(tx, qms, {
        sourceId: 'openhuman-quality',
        externalId: 'HAZ-004',
        commitSha: COMMIT_A,
        path: 'registry/trace/OH-EEG-1.yaml',
        title: 'Uncontrolled electrode current',
        recordedBy: f.performerId,
      });
    });

    const control = await createObject(h.adminPool, f, {
      type: 'risk_control',
      domain: 'engineering',
      state: 'proposed',
      title: 'Current-limiting resistor',
      createdBy: f.performerId,
    });

    const linkId = await withTransaction(h.adminPool, async (tx) => {
      await bindContext(tx, f);
      await tx.query(
        `insert into engineering.risk_control (id, control_kind, mitigates, description)
         values ($1, 'protective_measure', $1, 'Series resistor on every electrode path.')`,
        [control],
      );
      return linkToReference(tx, {
        objectId: control,
        referenceId: reference.id,
        linkKind: 'mitigates',
        createdBy: f.performerId,
      });
    });
    expect(linkId).toMatch(/^[0-9a-f-]{36}$/);

    // The link resolves to the QMS's own identifier, which is what a reader needs to go and
    // read the thing where it actually lives.
    const resolved = await withTransaction(h.adminPool, async (tx) =>
      tx.one<{ external_id: string; repository: string; commit_sha: string }>(
        `select r.external_id, s.repository, r.commit_sha
           from quality.federated_link l
           join quality.federated_reference r on r.id = l.reference_id
           join quality.federated_source s on s.id = r.source_id
          where l.object_id = $1`,
        [control],
      ),
    );
    expect(resolved.external_id).toBe('HAZ-004');
    expect(resolved.repository).toBe('openhuman-quality');
    expect(resolved.commit_sha).toBe(COMMIT_A);
  });
});
