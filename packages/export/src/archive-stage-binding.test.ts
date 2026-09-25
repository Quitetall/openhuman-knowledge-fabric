import { expect, it } from 'vitest';
import { bindArchiveStages } from './archive-stage-binding.js';

const packet = {
  dispatch_digest: 'd'.repeat(64),
  contract_revision: 1,
  stage_id: 'S1',
  milestone_id: 'M1',
};
const declaration = {
  source: 'docs/warrants/W1/atoms/stages.yaml',
  source_digest: `sha256:${'a'.repeat(64)}`,
  manifest_source: 'docs/warrants/W1/manifest.toml',
  graph: { stages: [{ id: 'S1' }], milestones: [{ id: 'M1', stage_refs: ['S1'] }] },
};
const inventory = {
  declarations: [declaration],
  unresolved: [],
  history_retained: true,
  execution_coverage_established: false,
};

it('binds stage and milestone membership to current source and exposes unmatched packets', () => {
  const result = bindArchiveStages(inventory, 1, [packet]);
  expect(result.matches).toEqual([
    {
      dispatchDigest: packet.dispatch_digest,
      stageId: 'S1',
      milestoneId: 'M1',
      source: declaration.source,
      sourceDigest: declaration.source_digest,
      manifestSource: declaration.manifest_source,
    },
  ]);
  expect(result.unresolved).toEqual([]);
  expect(result.executionCoverageEstablished).toBe(false);
  for (const mismatch of [
    { ...packet, stage_id: 'S2' },
    { ...packet, milestone_id: 'M2' },
  ]) {
    const missing = bindArchiveStages(inventory, 1, [mismatch]);
    expect(missing.matches).toEqual([]);
    expect(missing.unresolved).toHaveLength(1);
  }
  const noMember = {
    ...inventory,
    declarations: [
      {
        ...declaration,
        graph: { stages: [{ id: 'S1' }], milestones: [{ id: 'M1', stage_refs: [] }] },
      },
    ],
  };
  expect(bindArchiveStages(noMember, 1, [packet]).matches).toEqual([]);
});

it('does not substitute historical graphs or absent inventories and refuses ambiguous or malformed declarations', () => {
  const historical = {
    ...inventory,
    declarations: [
      {
        ...declaration,
        manifest_source: '__ow_archive__/history/abc/docs/warrants/W1/manifest.toml',
      },
    ],
  };
  expect(bindArchiveStages(historical, 1, [packet]).matches).toEqual([]);
  expect(
    bindArchiveStages(inventory, 1, [{ ...packet, contract_revision: 2 }]).unresolved[0]?.[
      'reason'
    ],
  ).toContain('historical source');
  expect(bindArchiveStages(undefined, 1, [packet]).unresolved[0]?.['reason']).toContain(
    'unavailable',
  );
  expect(() =>
    bindArchiveStages({ ...inventory, declarations: [declaration, declaration] }, 1, [packet]),
  ).toThrow(/Ambiguous/);
  expect(() =>
    bindArchiveStages(
      { ...inventory, declarations: [{ ...declaration, source_digest: 'wrong' }] },
      1,
      [packet],
    ),
  ).toThrow(/Invalid archive stage/);
  expect(() =>
    bindArchiveStages({ ...inventory, execution_coverage_established: true }, 1, []),
  ).toThrow(/Invalid archive stage inventory/);
});
