/**
 * Ontology compiler.
 *
 * `ontology/*.yaml` is canonical; everything under `generated/` is output. CI fails on
 * drift, because a hand-edited generated file is an ontology change nobody reviewed.
 */

export { loadOntology, OntologyError } from './model.js';
export type {
  ActionType,
  Field,
  ObjectType,
  Ontology,
  ProjectionDefinition,
  ProjectionFilter,
  ProjectionParameter,
  ProjectionSection,
  ProjectionSelect,
  ProjectionTraverse,
  RelationType,
  Rule,
  RuleImplementation,
  SharedType,
  StateMachine,
  Transition,
} from './model.js';
export { checkOntology, formatFindings } from './check.js';
export type { Finding } from './check.js';
export { buildArtifacts, findDrift, writeArtifacts } from './build.js';
export type { Artifact, DriftEntry } from './build.js';
export { emitJsonSchema, defName } from './emit/json-schema.js';
export type { Json } from './emit/json-schema.js';
export {
  emitJsonLdContext,
  emitShacl,
  emitStateMachines,
  emitVocabulary,
} from './emit/interchange.js';
export { emitDocumentation, emitOpenApi, emitSqlRegistry, emitTypeScript } from './emit/code.js';
export { buildReleasePack, packGaps } from './pack.js';
export type { PackFile } from './pack.js';

// Identifier policy — OH-DOC-000001-3. A separate authority from the ontology above (§1.1),
// compiled from the configured registry directory and packaged through the same approval flow.
export {
  buildRegistryPack,
  checkRegistryPolicy,
  loadRegistryPolicy,
  registryPackGaps,
} from './registry-pack.js';
export type { CheckFailure, RegistryPolicy } from './registry-pack.js';
export {
  DAMM_TABLE,
  ENTERPRISE_NAMESPACES,
  dammCheck,
  dammValid,
  formatEnterpriseId,
  isAntiSymmetricQuasigroup,
  validateIdentifier,
} from './damm.js';
export type { IdentifierKind, IdentifierVerdict } from './damm.js';
