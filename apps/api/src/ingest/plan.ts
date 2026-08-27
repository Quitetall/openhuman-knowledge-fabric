/**
 * Turning a set of file paths into an ingest batch — or refusing the whole batch.
 *
 * Two things decide how a file enters KF, and neither has a default:
 *
 *   mode            copy      we take the bytes and hold them
 *                   reference we record that bytes with this digest exist elsewhere
 *   classification  the ceiling below which the resulting object is visible
 *
 * Both are required per batch. A default for either is how the wrong thing happens quietly:
 * a default mode copies third-party material because somebody forgot a flag, and a default
 * classification either over-discloses everything that follows or hides it from the person who
 * needed it.
 *
 * REFERENCE-ONLY PATHS are the load-bearing part. Vendor datasheets are somebody else's
 * copyright and the standing rule is that they are referenced by document number, revision and
 * hash — never held. So a `copy` run that touches one is refused, and refused ENTIRELY: a
 * partial ingest that copied nine files and rejected the tenth leaves a person deciding whether
 * to re-run, and that decision is where the tenth file quietly gets copied anyway.
 *
 * This module is deliberately pure. It reads no database and writes nothing, so the refusal can
 * be proven without a harness and cannot be excused by "the environment was odd".
 */

import { basename, extname, sep } from 'node:path';

export type IngestMode = 'copy' | 'reference';

/** A path segment or filename fragment that means "we must not hold these bytes". */
interface ReferenceOnlyRule {
  readonly id: string;
  /** Matched against lowercased path segments, or the filename for `filenameContains`. */
  readonly segment?: string;
  readonly filenameContains?: string;
  readonly reason: string;
}

/**
 * Deliberately explicit and short rather than a glob language. Every entry here is a claim
 * that material in that location is not ours to copy, and each one should be readable by
 * somebody deciding whether it is true.
 */
export const REFERENCE_ONLY_RULES: readonly ReferenceOnlyRule[] = [
  { id: 'vendor-tree', segment: 'vendor', reason: 'vendor material is third-party copyright' },
  { id: 'vendors-tree', segment: 'vendors', reason: 'vendor material is third-party copyright' },
  {
    id: 'supplier-tree',
    segment: 'supplier',
    reason: 'supplier material is held under agreement, not owned',
  },
  {
    id: 'suppliers-tree',
    segment: 'suppliers',
    reason: 'supplier material is held under agreement, not owned',
  },
  {
    id: 'third-party-tree',
    segment: 'third-party',
    reason: 'third-party material is not ours to reproduce',
  },
  {
    id: 'thirdparty-tree',
    segment: 'thirdparty',
    reason: 'third-party material is not ours to reproduce',
  },
  {
    id: 'datasheet-tree',
    segment: 'datasheets',
    reason: 'datasheets are referenced by document number and revision, never copied',
  },
  {
    id: 'datasheet-name',
    filenameContains: 'datasheet',
    reason: 'datasheets are referenced by document number and revision, never copied',
  },
];

export interface ReferenceOnlyMatch {
  readonly path: string;
  readonly ruleId: string;
  readonly reason: string;
}

/** The first rule that claims this path, or undefined. */
export function referenceOnlyRuleFor(path: string): ReferenceOnlyMatch | undefined {
  const segments = path.toLowerCase().split(sep).filter(Boolean);
  const name = basename(path).toLowerCase();
  for (const rule of REFERENCE_ONLY_RULES) {
    const hit =
      (rule.segment !== undefined && segments.includes(rule.segment)) ||
      (rule.filenameContains !== undefined && name.includes(rule.filenameContains));
    if (hit) return { path, ruleId: rule.id, reason: rule.reason };
  }
  return undefined;
}

/**
 * Descriptive only — which tool opens the thing. Unlike mode, guessing here is safe: being
 * wrong about whether something is a `drawing` or a `specification` misfiles it, it does not
 * reproduce anybody's copyright. Overridable per batch.
 */
const KIND_BY_EXTENSION = new Map<string, string>([
  ['.step', 'cad_assembly'],
  ['.stp', 'cad_assembly'],
  ['.sldasm', 'cad_assembly'],
  ['.f3d', 'cad_assembly'],
  ['.sldprt', 'cad_part'],
  ['.ipt', 'cad_part'],
  ['.stl', 'cad_part'],
  ['.dwg', 'drawing'],
  ['.dxf', 'drawing'],
  ['.sch', 'schematic'],
  ['.kicad_sch', 'schematic'],
  ['.kicad_pcb', 'pcb_layout'],
  ['.brd', 'pcb_layout'],
  ['.csv', 'dataset'],
  ['.json', 'dataset'],
  ['.md', 'specification'],
  ['.txt', 'specification'],
  ['.pdf', 'report'],
  ['.png', 'photograph'],
  ['.jpg', 'photograph'],
  ['.jpeg', 'photograph'],
]);

const MEDIA_TYPE_BY_EXTENSION = new Map<string, string>([
  ['.md', 'text/markdown'],
  ['.txt', 'text/plain'],
  ['.json', 'application/json'],
  ['.csv', 'text/csv'],
  ['.pdf', 'application/pdf'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.step', 'model/step'],
  ['.stp', 'model/step'],
  ['.stl', 'model/stl'],
]);

export function artifactKindFor(path: string, override?: string): string {
  if (override !== undefined) return override;
  return KIND_BY_EXTENSION.get(extname(path).toLowerCase()) ?? 'other';
}

export function mediaTypeFor(path: string): string {
  return MEDIA_TYPE_BY_EXTENSION.get(extname(path).toLowerCase()) ?? 'application/octet-stream';
}

export interface IngestRequest {
  readonly mode?: string;
  readonly classification?: string;
  readonly paths: readonly string[];
  readonly artifactKind?: string;
  /** Required in reference mode: which revision of the external thing this digest describes. */
  readonly revisionLabel?: string;
}

export interface PlannedItem {
  readonly path: string;
  readonly artifactKind: string;
  readonly mediaType: string;
}

export type IngestPlan =
  | {
      readonly ok: true;
      readonly mode: IngestMode;
      readonly classification: string;
      readonly items: readonly PlannedItem[];
    }
  | { readonly ok: false; readonly refusals: readonly string[] };

/**
 * Refuses the whole batch on the first class of problem found, reporting every instance of it
 * so one run tells you everything you have to fix.
 */
export function planIngest(request: IngestRequest): IngestPlan {
  const refusals: string[] = [];

  if (request.mode === undefined) {
    refusals.push(
      'no --mode given. State copy or reference explicitly: a default would decide, for you ' +
        'and silently, whether third-party bytes enter this system.',
    );
  } else if (request.mode !== 'copy' && request.mode !== 'reference') {
    refusals.push(`unknown --mode ${request.mode}; expected copy or reference`);
  }

  if (request.classification === undefined) {
    refusals.push(
      'no --classification given. Every object needs a ceiling, and guessing one either ' +
        'over-discloses this batch or hides it from the person who needed it.',
    );
  }

  if (request.paths.length === 0) refusals.push('no paths given');

  if (request.mode === 'reference' && request.revisionLabel === undefined) {
    refusals.push(
      'reference mode needs --revision. content.artifact_version requires a version to be ' +
        'locatable (storage_uri or revision_label), so a reference with no revision cannot ' +
        'say WHICH external thing the digest describes.',
    );
  }

  if (request.mode === 'copy') {
    for (const path of request.paths) {
      const match = referenceOnlyRuleFor(path);
      if (match !== undefined) {
        refusals.push(
          `refusing to copy ${match.path}: rule ${match.ruleId} — ${match.reason}. ` +
            'Re-run this batch with --mode=reference --revision=<document revision>.',
        );
      }
    }
  }

  if (refusals.length > 0) return { ok: false, refusals };

  const mode = request.mode as IngestMode;
  const classification = request.classification as string;
  return {
    ok: true,
    mode,
    classification,
    items: request.paths.map((path) => ({
      path,
      artifactKind: artifactKindFor(path, request.artifactKind),
      mediaType: mediaTypeFor(path),
    })),
  };
}
