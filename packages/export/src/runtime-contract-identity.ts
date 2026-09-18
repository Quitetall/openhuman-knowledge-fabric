import { isRecord } from './internal/format.js';

/** KF revision_no is a ledger counter; OW contract_revision lives in canonical IR. */
export function runtimeContractIdentity(row: Readonly<Record<string, unknown>>, warrantId: string) {
  let ir: unknown = row['canonical_ir'];
  if (isRecord(ir) && (ir['$kf_type'] === 'postgres.jsonb' || ir['$kf_type'] === 'postgres.json')) {
    if (typeof ir['text'] !== 'string') throw new Error('Invalid retained canonical IR wrapper');
    ir = JSON.parse(ir['text']) as unknown;
  }
  if (!isRecord(ir) || ir['api_version'] !== 'oh.war/v1') return undefined;
  if (
    !isRecord(ir['identity']) ||
    ir['identity']['uuid'] !== warrantId ||
    !Number.isSafeInteger(ir['contract_revision']) ||
    Number(ir['contract_revision']) < 1 ||
    typeof row['contract_digest'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(row['contract_digest'])
  ) {
    throw new Error('Invalid retained source contract identity');
  }
  return { revision: Number(ir['contract_revision']), digest: row['contract_digest'] };
}
