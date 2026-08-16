import type { AggregateKind, AggregateReference } from '@kf/ml-registry';

import type {
  AggregateProjection,
  CanonicalReferenceColumns,
  ReferenceColumns,
} from './contracts.js';
import { invalid } from './error.js';
import {
  decodeAggregateKind,
  decodeGovernedId,
  decodeOpaqueId,
  decodeOrganizationId,
  decodeSha256,
} from './scalars.js';

export function decodeReference(
  columns: ReferenceColumns,
  field: string,
  expectedKinds?: readonly AggregateKind[],
): AggregateProjection {
  const kind = decodeAggregateKind(columns.kind, `${field}.kind`);
  if (expectedKinds !== undefined && !expectedKinds.includes(kind)) invalid(`${field}.kind`);
  return {
    kind,
    authorityId: decodeOpaqueId(columns.authorityId, `${field}.authorityId`),
    revisionId: decodeOpaqueId(columns.revisionId, `${field}.revisionId`),
    sha256: decodeSha256(columns.sha256, `${field}.sha256`),
    classificationId: decodeGovernedId(columns.classificationId, `${field}.classificationId`),
    policyId: decodeGovernedId(columns.policyId, `${field}.policyId`),
  };
}

export function decodeCanonicalReference(
  columns: CanonicalReferenceColumns,
  field: string,
  expectedKinds?: readonly AggregateKind[],
): AggregateReference {
  return {
    organizationId: decodeOrganizationId(columns.organizationId, `${field}.organizationId`),
    ...decodeReference(columns, field, expectedKinds),
  };
}

export function decodeNullableReference(
  columns: ReferenceColumns,
  field: string,
  expectedKinds?: readonly AggregateKind[],
): AggregateProjection | null {
  const values = Object.values(columns);
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) invalid(field);
  return decodeReference(columns, field, expectedKinds);
}

export function decodeNullableCanonicalReference(
  columns: CanonicalReferenceColumns,
  field: string,
  expectedKinds?: readonly AggregateKind[],
): AggregateReference | null {
  const values = Object.values(columns);
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null)) invalid(field);
  return decodeCanonicalReference(columns, field, expectedKinds);
}

export function refSelect(alias: string, prefix: string): string {
  return `${alias}.aggregate_kind as ${prefix}_kind,
          ${alias}.authority_id as ${prefix}_authority_id,
          ${alias}.revision_id as ${prefix}_revision_id,
          ${alias}.sha256 as ${prefix}_sha256,
          ${alias}.classification_id as ${prefix}_classification_id,
          ${alias}.policy_id as ${prefix}_policy_id`;
}

export function canonicalRefSelect(alias: string, prefix: string): string {
  return `${alias}.organization_id::text as ${prefix}_organization_id,
          ${refSelect(alias, prefix)}`;
}
