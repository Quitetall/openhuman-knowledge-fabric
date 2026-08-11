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
