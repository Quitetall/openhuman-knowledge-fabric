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

/**
 * The longest title a record may carry: `core.object` checks `length(btrim(title)) between 1 and
 * 240`, counting characters (code points) after trimming spaces.
 */
export const OBJECT_TITLE_MAX_CHARACTERS = 240;

/**
 * Why `title` cannot be a record's title, or undefined when it can. The database's own rule, said
 * before the insert so a caller gets a refusal naming the field rather than a check violation
 * surfacing as a 500. NUL is refused too: PostgreSQL text cannot hold it at all.
 */
export function objectTitleProblem(title: string): string | undefined {
  if (title.includes('\u0000')) return 'title must not contain NUL characters';
  const characters = [...title.replace(/^ +| +$/gu, '')].length;
  if (characters < 1 || characters > OBJECT_TITLE_MAX_CHARACTERS) {
    return `title must be 1 to ${String(OBJECT_TITLE_MAX_CHARACTERS)} characters; it is ${String(characters)}`;
  }
  return undefined;
}

export async function createControlledObject(tx: Tx, spec: NewObject): Promise<string> {
  const titleProblem = objectTitleProblem(spec.title);
  if (titleProblem !== undefined) throw new PayloadInvalid('title', titleProblem);
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

/**
 * A payload field the act needs is missing or malformed. The caller's input is the cause, so
 * the dispatcher turns this into a `precondition_failed` refusal naming the field; before it
 * existed these were plain Errors and reached an HTTP caller as a 500 they would retry forever.
 */
export class PayloadInvalid extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'PayloadInvalid';
    this.field = field;
  }
}

export function requireString(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string {
  const value = payload?.[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PayloadInvalid(key, `${key} is required and must be a non-empty string`);
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
    throw new PayloadInvalid(
      key,
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
    throw new PayloadInvalid(
      key,
      `${key} is required and must be a non-negative integer in minor units`,
    );
  }
  return value;
}

export function requireCurrency(
  payload: Readonly<Record<string, unknown>> | undefined,
  key = 'currency',
): string {
  const value = requireString(payload, key);
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new PayloadInvalid(key, `${key} must be a three-letter ISO 4217 code`);
  }
  return value;
}

export const PACKAGE = {
  name: '@kf/record-atoms',
  role: 'Reusable controlled-record creation and payload-validation atoms',
  owns: [],
} as const;

/**
 * The record's classification as the act states it, for every materializer that creates a
 * record. Absent from the payload, nothing is spread and the envelope default (`internal`)
 * applies. The insert policy on core.object refuses a classification above the session's bound
 * ceiling, so a payload cannot widen; it can only say what the record is.
 *
 * Until 2026-09-11 only the artifact materializers read this, and every decision record,
 * configuration item, project and test definition was `internal` whatever the act said.
 */
export function classificationFrom(payload: Readonly<Record<string, unknown>> | undefined): {
  readonly classification?: string;
} {
  const value = optionalString(payload, 'classification');
  return value === null ? {} : { classification: value };
}
