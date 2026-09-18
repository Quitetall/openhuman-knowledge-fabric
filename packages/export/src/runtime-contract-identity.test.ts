import { expect, it } from 'vitest';
import { runtimeContractIdentity } from './runtime-contract-identity.js';

it('reads source revision from retained JSONB IR rather than the provider ledger counter', () => {
  const ir = { api_version: 'oh.war/v1', identity: { uuid: 'w1' }, contract_revision: 1 };
  const row = {
    revision_no: 2,
    contract_digest: 'a'.repeat(64),
    canonical_ir: { $kf_type: 'postgres.jsonb', text: JSON.stringify(ir) },
  };
  expect(runtimeContractIdentity(row, 'w1')).toEqual({ revision: 1, digest: 'a'.repeat(64) });
  expect(() => runtimeContractIdentity(row, 'other')).toThrow(/source contract identity/);
  expect(runtimeContractIdentity({ ...row, canonical_ir: {} }, 'w1')).toBeUndefined();
  expect(() =>
    runtimeContractIdentity({ ...row, canonical_ir: { ...ir, contract_revision: 0 } }, 'w1'),
  ).toThrow(/source contract identity/);
  expect(() =>
    runtimeContractIdentity(
      { ...row, canonical_ir: { $kf_type: 'postgres.jsonb', text: '{' } },
      'w1',
    ),
  ).toThrow();
});
