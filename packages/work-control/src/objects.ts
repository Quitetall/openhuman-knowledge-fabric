/**
 * Creating a controlled object.
 *
 * One function, used by every materializer, because the fields a controlled record must carry
 * — classification, retention class, schema version, owning organization, who created it —
 * are the ones most easily forgotten, and a record missing any of them is not governable.
 * Making them parameters of a single call means "forgot to set retention" is a type error
 * rather than a discovery during an audit.
 */

import type { Tx } from '@kf/database';

export interface NewObject {
  readonly objectType: string;
  readonly authorityDomain: string;
  /** Must be the initial state of this type's machine; the action then moves it on. */
  readonly lifecycleState: string;
  readonly title: string;
  readonly organizationId: string;
  readonly createdBy: string;
  readonly classification?: string;
  readonly retentionClass?: string;
}

export async function createControlledObject(tx: Tx, spec: NewObject): Promise<string> {
  const { version } = await tx.one<{ version: string }>(
    'select version from registry.schema_release where is_current',
  );
  const row = await tx.one<{ id: string }>(
    `insert into core.object
       (object_type, authority_domain, lifecycle_state, classification, retention_class,
        schema_version, organization_id, title, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
     returning id`,
    [
      spec.objectType,
      spec.authorityDomain,
      spec.lifecycleState,
      spec.classification ?? 'internal',
      spec.retentionClass ?? 'project_record',
      version,
      spec.organizationId,
      spec.title,
      spec.createdBy,
    ],
  );
  return row.id;
}

/** Read a required string from an action payload, with a message naming what is missing. */
export function requireString(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string {
  const v = payload?.[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${key} is required and must be a non-empty string`);
  }
  return v;
}

/**
 * Read a required money amount in MINOR units.
 *
 * Rejects non-integers rather than rounding. A ceiling of 1000.5 pence is not a number anyone
 * meant to write, and silently rounding it decides on the caller's behalf which way the money
 * goes.
 *
 * `Number.isSafeInteger` is the entry gate for every amount in the system, which is what
 * makes `Number(...)` safe on the way back out: the database columns are `bigint` and arrive
 * as strings, but no value that got past this check can exceed 2^53 minor units — about
 * ninety trillion pounds. Sums are compared in SQL, where they stay `bigint` throughout.
 */
export function requireMinor(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number {
  const v = payload?.[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new Error(`${key} is required and must be a non-negative integer in minor units`);
  }
  return v;
}

export function requireCurrency(
  payload: Readonly<Record<string, unknown>> | undefined,
  key = 'currency',
): string {
  const v = requireString(payload, key);
  if (!/^[A-Z]{3}$/.test(v)) throw new Error(`${key} must be a three-letter ISO 4217 code`);
  return v;
}

export function optionalString(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | null {
  const v = payload?.[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
