import type { ProjectionDefinition } from '@kf/ontology-compiler';

export type ProjectionClassification = 'public' | 'internal' | 'confidential' | 'restricted';

/**
 * One member of a corpus as a projection sees it. Deliberately the master record's own member
 * shape and nothing more: a projection cannot enrich, only partition and order.
 */
export interface ProjectionMember {
  readonly objectId: string;
  readonly objectType: string;
  readonly organizationId: string;
  readonly classification: ProjectionClassification;
  readonly contentDigest: string;
  readonly lifecycleState?: string;
  readonly itemState: 'included' | 'withdrawn';
  readonly title?: string;
  readonly content?: Readonly<Record<string, unknown>>;
  readonly withdrawnAt?: string;
  readonly withdrawalReason?: string;
}

/** The corpus a projection reads. `corpusDigest` is the master's identity (ADR 0013). */
export interface ProjectionCorpus {
  readonly personId: string;
  readonly organizationId: string;
  readonly corpusDigest: string;
  readonly members: readonly ProjectionMember[];
}

export interface RelevanceEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly relationType: string;
}

export type RelationPropagationClass =
  | 'composition_down'
  | 'version_both'
  | 'provenance_backward'
  | 'lateral_none'
  | 'authority_one_hop_up';

export interface RelationPolicy {
  readonly relationType: string;
  readonly personAnchor: boolean;
  readonly propagationClass: RelationPropagationClass;
  readonly anchorDepth: number;
}

export interface ProjectionGraph {
  readonly edges: readonly RelevanceEdge[];
  readonly policies: readonly RelationPolicy[];
}

export type ProjectionParameterValue = string | number | boolean;

export interface ProjectionInput {
  readonly definition: ProjectionDefinition;
  readonly parameters: Readonly<Record<string, ProjectionParameterValue>>;
  readonly corpus: ProjectionCorpus;
  readonly graph: ProjectionGraph;
}

export interface ProjectionResultSection {
  readonly id: string;
  readonly title: string;
  readonly members: readonly ProjectionMember[];
}

/**
 * The canonical JSON every surface consumes — the web page, a PDF, an agent bundle. It carries
 * exactly which members it holds and which corpus they came from, and a digest of itself, so
 * "what did this reader see" is a stored fact rather than a reconstruction.
 */
export interface ProjectionResult {
  readonly format: 'kf-projection-result-v1';
  readonly definition: { readonly id: string; readonly version: number };
  readonly parameters: Readonly<Record<string, ProjectionParameterValue>>;
  readonly source: {
    readonly personId: string;
    readonly organizationId: string;
    readonly corpusDigest: string;
  };
  readonly sections: readonly ProjectionResultSection[];
  /**
   * For an object-anchored reading: the active edges among the Result's members that the
   * neighbourhood walk crossed, both directions. This IS the reading's outcome for a
   * neighbourhood — a relationship page without its edges is a list — so it is part of the
   * projection digest. Absent for person-anchored readings, whose outcome is membership.
   */
  readonly edges?: readonly RelevanceEdge[];
  readonly measurements: {
    /** Members admitted by the definition filter and placed in sections. */
    readonly memberCount: number;
    /** Members in the corpus before the definition filter. */
    readonly corpusMemberCount: number;
    /** corpusMemberCount - memberCount: the declared narrowing, counted rather than silent. */
    readonly excludedByFilter: number;
    readonly sectionCounts: Readonly<Record<string, number>>;
    readonly reachedCount: number;
    readonly relevanceFanoutByAnchorType: Readonly<Record<string, number>>;
    readonly relevanceFanoutByPropagationClass: Readonly<Record<string, number>>;
  };
  readonly projectionDigest: string;
}
