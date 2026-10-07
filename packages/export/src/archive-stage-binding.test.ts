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

it('binds historical membership only to its reconstructed contract and exact snapshot', () => {
  const historical = {
    ...declaration,
    source: '__ow_archive__/history/old/docs/warrants/W1/atoms/stages.yaml',
    manifest_source: '__ow_archive__/history/old/docs/warrants/W1/manifest.toml',
    contract_binding: {
      revision: 1,
      digest: 'c'.repeat(64),
      reconstructed: true,
      ir_source: '__ow_archive__/history/old/docs/warrants/W1/generated/WAR.json',
      ir_source_digest: `sha256:${'b'.repeat(64)}`,
    },
  };
  const source = { ...inventory, declarations: [historical] };
  const dispatch = { ...packet, contract_digest: 'c'.repeat(64) };
  expect(bindArchiveStages(source, 2, [dispatch]).matches[0]).toMatchObject({
    source: historical.source,
    manifestSource: historical.manifest_source,
  });
  for (const wrong of [
    { ...dispatch, contract_digest: 'e'.repeat(64) },
    { ...dispatch, contract_revision: 3 },
    { ...dispatch, milestone_id: 'M2' },
  ])
    expect(bindArchiveStages(source, 2, [wrong]).matches).toEqual([]);
  expect(
    bindArchiveStages(
      { ...inventory, declarations: [{ ...declaration, contract_binding: null }] },
      1,
      [dispatch],
    ).matches,
  ).toEqual([]);
  expect(() =>
    bindArchiveStages(
      {
        ...source,
        declarations: [
          {
            ...historical,
            contract_binding: {
              ...historical.contract_binding,
              ir_source: '__ow_archive__/WAR.json',
            },
          },
        ],
      },
      2,
      [dispatch],
    ),
  ).toThrow(/Invalid archive stage contract binding/);
  const repeated = {
    ...historical,
    source: historical.source.replace('/old/', '/other/'),
    manifest_source: historical.manifest_source.replace('/old/', '/other/'),
    contract_binding: {
      ...historical.contract_binding,
      ir_source: historical.contract_binding.ir_source.replace('/old/', '/other/'),
    },
  };
  const result = bindArchiveStages({ ...inventory, declarations: [repeated, historical] }, 2, [
    dispatch,
  ]);
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0]?.['equivalentSources']).toHaveLength(2);
  expect(() =>
    bindArchiveStages(
      {
        ...inventory,
        declarations: [historical, { ...repeated, source_digest: `sha256:${'f'.repeat(64)}` }],
      },
      2,
      [dispatch],
    ),
  ).toThrow(/Ambiguous/);
  expect(result.executionCoverageEstablished).toBe(false);
});
