import type { Tx } from '@kf/database';

/** Current database capability required before ML routes may interpret timestamptz rows. */
export async function hasRequiredSchema(tx: Tx): Promise<boolean> {
  const row = await tx.one<{ available: unknown }>(
    `/* ml.schema-contract */
     select to_regprocedure(
              'core.is_canonical_wire_timestamp(timestamp with time zone)'
            ) is not null as available`,
  );
  return row.available === true;
}

export class MlSchemaUnavailable extends Error {
  constructor() {
    super('required ML database contract is unavailable');
    this.name = 'MlSchemaUnavailable';
  }
}

/** Fail closed before a pre-025 database can pass lossy timestamps through node-postgres. */
export async function requireMlSchema(tx: Tx): Promise<void> {
  if (!(await hasRequiredSchema(tx))) throw new MlSchemaUnavailable();
}
