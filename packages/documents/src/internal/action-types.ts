import type { ActionEffect, ActionMaterializer, PreconditionCheck } from '@kf/actions';
import { requireString } from '@kf/record-atoms';

export function requireSha256(payload: Readonly<Record<string, unknown>> | undefined): string {
  const value = requireString(payload, 'sha256');
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('sha256 must be lowercase hexadecimal');
  return value;
}

export interface DocumentActionAtoms {
  readonly name: string;
  readonly ownedActions: readonly string[];
  readonly materializers: Readonly<Record<string, ActionMaterializer>>;
  readonly effects: Readonly<Record<string, ActionEffect>>;
  readonly preconditions: Readonly<Record<string, PreconditionCheck>>;
}

export const DOCUMENT_ACTION_IDS = [
  'attach_evidence',
  'add_controlled_document',
  'add_authored_fragment',
  'revise_authored_fragment',
  'retire_authored_fragment',
  'add_document_composition',
  'revise_document_composition',
  'change_document_source_holder',
  'request_document_compilation',
  'compile_master_record',
  'accept_document_compilation',
  'publish_document_view',
  'record_document_proposal',
  'apply_document_proposal',
  'release_person_entitlement_exclusion',
  'register_external_artifact',
] as const;

export const DOCUMENT_AUTHOR_ROLES = new Set([
  'performer',
  'technical_authority',
  'design_authority',
  'quality_authority',
]);
export const TECHNICAL_AUTHORITY_ROLE = new Set(['technical_authority']);
