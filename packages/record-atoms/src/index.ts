/** Small atoms shared by action modules. These functions own no domain facts. */

import type { Tx } from '@kf/database';

export interface NewObject {
  readonly objectType: string;
  readonly authorityDomain: string;
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

export function requireString(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string {
  const value = payload?.[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} is required and must be a non-empty string`);
  }
  return value;
}

export function optionalString(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | null {
  const value = payload?.[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function requireInteger(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
  minimum = 0,
): number {
  const value = payload?.[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(
      `${key} is required and must be an integer greater than or equal to ${minimum}`,
    );
  }
  return value;
}

export function requireMinor(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number {
  const value = payload?.[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${key} is required and must be a non-negative integer in minor units`);
  }
  return value;
}

export function requireCurrency(
  payload: Readonly<Record<string, unknown>> | undefined,
  key = 'currency',
): string {
  const value = requireString(payload, key);
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new Error(`${key} must be a three-letter ISO 4217 code`);
  }
  return value;
}

export const PACKAGE = {
  name: '@kf/record-atoms',
  role: 'Reusable controlled-record creation and payload-validation atoms',
  owns: [],
} as const;
