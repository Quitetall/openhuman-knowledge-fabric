/**
 * Corpus projections — declared, versioned readings of a master record (ADR 0013).
 *
 * A projection can only partition and order what the corpus already contains. The engine
 * enforces two invariants by construction and asserts them again: every member it emits came
 * from the corpus, and every member of the corpus lands in exactly one section.
 */

export { relevanceClosure, relevanceClosureWithMetrics } from './closure.js';
export { neighbourhood } from './neighbourhood.js';
export { loadProjectionDefinitions, type ProjectionDefinitionSet } from './definitions.js';
export { bindParameters, project, ProjectionRefused } from './engine.js';
export {
  renderProjection,
  renderProjectionHtml,
  renderProjectionMarkdown,
  type ProjectionRenderOptions,
  type ProjectionRenderTarget,
  type RenderedProjection,
} from './render.js';
export type {
  ProjectionClassification,
  ProjectionCorpus,
  ProjectionGraph,
  ProjectionInput,
  ProjectionMember,
  ProjectionParameterValue,
  ProjectionResult,
  ProjectionResultSection,
  RelationPolicy,
  RelationPropagationClass,
  RelevanceEdge,
} from './types.js';

export const PACKAGE = {
  name: '@kf/projections',
  role: 'Corpus projection engine',
  owns: [],
} as const;
