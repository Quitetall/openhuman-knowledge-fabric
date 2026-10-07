/**
 * The qualification pack document (`kf-qualification-pack-v1`), its validator and its
 * composition (ADR 0038 decisions 3, 4, 5, 10; KF-SAS-RQ-254, RQ-255, RQ-260).
 *
 * A pack is DATA. A new role needs a new pack and no code: nothing in this module, the evaluator,
 * a route, a view or a policy names a role or a title (RQ-254). The document is closed:
 *
 *   - Composition is an explicit list. `parts.common`, `parts.role` and `parts.scope` name other
 *     packs by key and revision; `requirements` are this pack's own, each saying which part it
 *     belongs to. A part is itself a pack that composes nothing — there is no inheritance, no
 *     chain of parts, and no key a script or expression could hide in. Any key the schema does
 *     not declare is refused, `extends`, `inherits`, `script` and `when` by name.
 *   - A requirement states the outcome that must be true, the stage it belongs to, the evidence
 *     that counts (one of three modes), who may accept it, and, if it is mandatory, what becomes
 *     unsafe, unauthorized or unreliable without it (RQ-260). Resources are referenced by
 *     identifier and revision and never copied.
 *   - A requirement shared by two parts is ONE requirement: composition keys by requirement key,
 *     so it appears once and is satisfied once. Two parts that disagree about it are refused.
 *
 * `validatePackDocument` is pure: everything it needs about other packs is passed in, so the
 * same check runs in a unit test, in the act that drafts a pack and in the act that approves it.
 * What only the database knows (does that resource exist at that revision, does that act declare
 * `requires_qualification`) is `checkPackReferences` in `acts.ts`, under the approver's own rows.
 */

import { taggedDigest } from '@kf/canonicalization';

export const PACK_FORMAT = 'kf-qualification-pack-v1' as const;
export const REQUIREMENT_FORMAT = 'kf-qualification-requirement-v1' as const;

/** The five stages, in the protocol's order (decision 1). Sections, not waiting rooms. */
export const STAGES = [
  'read_in',
  'role_read_in',
  'references',
  'execution',
  'first_contribution',
] as const;
export type Stage = (typeof STAGES)[number];

/** Decision 5. Reading, watching and listening are formats, not modes. */
export const EVIDENCE_MODES = ['acknowledge', 'locate', 'demonstrate'] as const;
export type EvidenceMode = (typeof EVIDENCE_MODES)[number];

/** Decision 5: references carry an authority class, and the References stage teaches it. */
export const AUTHORITY_CLASSES = ['normative', 'reference', 'learning'] as const;
export type AuthorityClass = (typeof AUTHORITY_CLASSES)[number];

export const PARTS = ['common', 'role', 'scope'] as const;
export type Part = (typeof PARTS)[number];

/** RQ-260: what becomes of the organization without the requirement. */
export const CONSEQUENCE_KINDS = ['unsafe', 'unauthorized', 'unreliable'] as const;
export type ConsequenceKind = (typeof CONSEQUENCE_KINDS)[number];

export const CLOSING_RULES = ['on_evidence', 'on_acceptance'] as const;
export type ClosingRule = (typeof CLOSING_RULES)[number];

export interface ResourceRef {
  readonly id: string;
  /** The revision the requirement was written against: a document revision, a version number. */
  readonly revision: string;
  readonly authority_class: AuthorityClass;
  /** A label for the reader; never the resource's content. */
  readonly label?: string;
}

export interface Consequence {
  readonly kind: ConsequenceKind;
  readonly statement: string;
}

/** A requirement as the pack document declares it. */
export interface RequirementDocument {
  readonly key: string;
  readonly revision: number;
  readonly part: Part;
  readonly stage: Stage;
  readonly outcome: string;
  readonly evidence_mode: EvidenceMode;
  /** `self` (acknowledgement only), `contact`, or `role:<role id>`. */
  readonly accepted_by: string;
  readonly mandatory: boolean;
  readonly consequence?: Consequence;
  /** Required on every revision after the first (RQ-259). */
  readonly behavioural_impact?: boolean;
  /** `organization`, or one scope object. */
  readonly scope?: 'organization' | { readonly object: string };
  readonly resources?: readonly ResourceRef[];
  readonly prerequisites?: readonly string[];
  /** Acts this requirement gates; each must declare `requires_qualification`. */
  readonly gates?: readonly string[];
  /** Requirements whose existing credit evidences this one (decision 7). */
  readonly equivalent_to?: readonly string[];
  /** How the help is given (reading, watching): never what counts as evidence. */
  readonly formats?: readonly string[];
}

export interface PartRef {
  readonly pack: string;
  readonly revision: number;
}

export interface PackDocument {
  readonly format: typeof PACK_FORMAT;
  readonly key: string;
  readonly revision: number;
  readonly title: string;
  /** Who maintains the pack: `role:<role id>`. */
  readonly owner: string;
  readonly closing: ClosingRule;
  /** For `on_acceptance` only: `role:<role id>`. */
  readonly acceptor?: string;
  readonly parts?: {
    readonly common?: readonly PartRef[];
    readonly role?: readonly PartRef[];
    readonly scope?: readonly PartRef[];
  };
  readonly requirements: readonly RequirementDocument[];
}

/** A requirement's definition as stored: the document's, without the pack-local `part`. */
export type RequirementDefinition = Omit<RequirementDocument, 'part'>;

/** One requirement of a composed pack, wherever it came from. */
export interface ComposedRequirement {
  readonly key: string;
  readonly revision: number;
  readonly part: Part;
  /** The part pack it was composed from; absent for the pack's own requirement. */
  readonly via?: PartRef;
  readonly definition: RequirementDefinition;
  readonly digest: string;
}

/** What the validator knows about another pack, resolved by the caller. */
export interface ResolvedPart {
  readonly key: string;
  readonly revision: number;
  readonly approved: boolean;
  /** True when the part itself composes parts: refused, composition is one explicit level. */
  readonly composesParts: boolean;
  readonly requirements: readonly ComposedRequirement[];
}

export type PackProblemCode =
  | 'format'
  | 'unknown_key'
  | 'missing_owner'
  | 'missing_field'
  | 'invalid_value'
  | 'duplicate_requirement'
  | 'conflicting_requirement'
  | 'dead_reference'
  | 'inaccessible_resource'
  | 'composition_cycle'
  | 'nested_composition'
  | 'prerequisite_cycle'
  | 'mandatory_without_consequence'
  | 'undeclared_behavioural_impact'
  | 'self_acceptance'
  | 'ungated_action';

export interface PackProblem {
  readonly code: PackProblemCode;
  readonly path: string;
  readonly message: string;
}

const KEY = /^[a-z0-9][a-z0-9._-]{0,159}$/;
const PACK_KEY = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const ROLE_AUTHORITY = /^role:[a-z_][a-z0-9_]*$/;
const ACTION = /^[a-z][a-z0-9_]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Words that would turn a declaration into a program. Refused by name. */
const PROGRAM_WORDS = new Set([
  'extends',
  'inherits',
  'inherit',
  'include',
  'includes',
  'import',
  'script',
  'scripts',
  'when',
  'if',
  'unless',
  'expression',
  'eval',
  'condition',
  'conditions',
  'rule',
  'rules',
]);

const PACK_KEYS = new Set([
  'format',
  'key',
  'revision',
  'title',
  'owner',
  'closing',
  'acceptor',
  'parts',
  'requirements',
]);
const PARTS_KEYS = new Set<string>(PARTS);
const PART_REF_KEYS = new Set(['pack', 'revision']);
const REQUIREMENT_KEYS = new Set([
  'key',
  'revision',
  'part',
  'stage',
  'outcome',
  'evidence_mode',
  'accepted_by',
  'mandatory',
  'consequence',
  'behavioural_impact',
  'scope',
  'resources',
  'prerequisites',
  'gates',
  'equivalent_to',
  'formats',
]);
const RESOURCE_KEYS = new Set(['id', 'revision', 'authority_class', 'label']);
const CONSEQUENCE_KEYS = new Set(['kind', 'statement']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function closedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  problems: PackProblem[],
): void {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    problems.push({
      code: 'unknown_key',
      path: `${path}.${key}`,
      message: PROGRAM_WORDS.has(key)
        ? `${key} is refused: composition is an explicit list of parts, with no inheritance ` +
          'language and no scripts (ADR 0038 decision 3)'
        : `${key} is not part of ${PACK_FORMAT}`,
    });
  }
}

function text(value: unknown, min = 1): value is string {
  return typeof value === 'string' && value.trim().length >= min;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function stringList(
  value: unknown,
  path: string,
  pattern: RegExp,
  problems: PackProblem[],
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.push({ code: 'invalid_value', path, message: `${path} must be a list` });
    return [];
  }
  const out: string[] = [];
  value.forEach((item, i) => {
    if (typeof item !== 'string' || !pattern.test(item)) {
      problems.push({
        code: 'invalid_value',
        path: `${path}[${String(i)}]`,
        message: `${JSON.stringify(item)} is not a valid entry`,
      });
    } else out.push(item);
  });
  return out;
}

/** The stored definition of a requirement: the document's, without `part`. */
export function requirementDefinition(requirement: RequirementDocument): RequirementDefinition {
  const { part: _part, ...definition } = requirement;
  void _part;
  return definition;
}

/** `taggedDigest('kf-qualification-requirement-v1', definition)`. */
export function requirementDigest(definition: RequirementDefinition): string {
  return taggedDigest(REQUIREMENT_FORMAT, definition as unknown as Record<string, unknown>);
}

/** `taggedDigest('kf-qualification-pack-v1', document without its format)`. */
export function packDigest(document: PackDocument): string {
  const { format: _format, ...rest } = document;
  void _format;
  return taggedDigest(PACK_FORMAT, rest as unknown as Record<string, unknown>);
}

function validateRequirement(
  raw: unknown,
  path: string,
  problems: PackProblem[],
): RequirementDocument | undefined {
  if (!isRecord(raw)) {
    problems.push({ code: 'invalid_value', path, message: 'a requirement is an object' });
    return undefined;
  }
  closedKeys(raw, REQUIREMENT_KEYS, path, problems);
  const before = problems.length;
  if (typeof raw['key'] !== 'string' || !KEY.test(raw['key'])) {
    problems.push({
      code: 'missing_field',
      path: `${path}.key`,
      message: 'a requirement needs a stable key',
    });
  }
  if (!positiveInteger(raw['revision'])) {
    problems.push({
      code: 'missing_field',
      path: `${path}.revision`,
      message: 'a requirement names its revision, a positive integer',
    });
  }
  if (!PARTS.includes(raw['part'] as Part)) {
    problems.push({
      code: 'missing_field',
      path: `${path}.part`,
      message: `part is one of ${PARTS.join(', ')}`,
    });
  }
  if (!STAGES.includes(raw['stage'] as Stage)) {
    problems.push({
      code: 'missing_field',
      path: `${path}.stage`,
      message: `stage is one of ${STAGES.join(', ')}`,
    });
  }
  if (!text(raw['outcome'], 8)) {
    problems.push({
      code: 'missing_field',
      path: `${path}.outcome`,
      message: 'a requirement states the outcome that must be true (KF-SAS-RQ-255)',
    });
  }
  const mode = raw['evidence_mode'];
  if (!EVIDENCE_MODES.includes(mode as EvidenceMode)) {
    problems.push({
      code: 'missing_field',
      path: `${path}.evidence_mode`,
      message: `the evidence that counts is one of ${EVIDENCE_MODES.join(', ')} (KF-SAS-RQ-255)`,
    });
  }
  const acceptedBy = raw['accepted_by'];
  if (acceptedBy === undefined || acceptedBy === null || acceptedBy === '') {
    problems.push({
      code: 'missing_owner',
      path: `${path}.accepted_by`,
      message: 'a requirement names who may accept it: self, contact or role:<role>',
    });
  } else if (
    typeof acceptedBy !== 'string' ||
    !(acceptedBy === 'self' || acceptedBy === 'contact' || ROLE_AUTHORITY.test(acceptedBy))
  ) {
    problems.push({
      code: 'invalid_value',
      path: `${path}.accepted_by`,
      message: 'accepted_by is self, contact or role:<role>',
    });
  } else if (acceptedBy === 'self' && mode !== 'acknowledge') {
    problems.push({
      code: 'self_acceptance',
      path: `${path}.accepted_by`,
      message:
        'a person accepts only their own acknowledgement; locate and demonstrate are accepted by ' +
        'someone else (KF-SAS-RQ-047)',
    });
  }
  if (typeof raw['mandatory'] !== 'boolean') {
    problems.push({
      code: 'missing_field',
      path: `${path}.mandatory`,
      message: 'mandatory is true or false',
    });
  }
  const consequence = raw['consequence'];
  if (consequence !== undefined) {
    if (!isRecord(consequence)) {
      problems.push({
        code: 'invalid_value',
        path: `${path}.consequence`,
        message: 'a consequence is { kind, statement }',
      });
    } else {
      closedKeys(consequence, CONSEQUENCE_KEYS, `${path}.consequence`, problems);
      if (!CONSEQUENCE_KINDS.includes(consequence['kind'] as ConsequenceKind)) {
        problems.push({
          code: 'invalid_value',
          path: `${path}.consequence.kind`,
          message: `kind is one of ${CONSEQUENCE_KINDS.join(', ')}`,
        });
      }
    }
  }
  if (
    raw['mandatory'] === true &&
    (!isRecord(consequence) ||
      !CONSEQUENCE_KINDS.includes(consequence['kind'] as ConsequenceKind) ||
      !text(consequence['statement'], 8))
  ) {
    problems.push({
      code: 'mandatory_without_consequence',
      path: `${path}.consequence`,
      message:
        'a mandatory requirement names what becomes unsafe, unauthorized or unreliable without ' +
        'it; if nothing does, it is optional reading (KF-SAS-RQ-260)',
    });
  }
  const impact = raw['behavioural_impact'];
  if (impact !== undefined && typeof impact !== 'boolean') {
    problems.push({
      code: 'invalid_value',
      path: `${path}.behavioural_impact`,
      message: 'behavioural_impact is true or false',
    });
  }
  if (positiveInteger(raw['revision']) && raw['revision'] > 1 && typeof impact !== 'boolean') {
    problems.push({
      code: 'undeclared_behavioural_impact',
      path: `${path}.behavioural_impact`,
      message:
        'a revision after the first declares whether it changes required behaviour: only one ' +
        'that does creates a gap (KF-SAS-RQ-259)',
    });
  }
  const scope = raw['scope'];
  if (
    scope !== undefined &&
    scope !== 'organization' &&
    !(
      isRecord(scope) &&
      Object.keys(scope).length === 1 &&
      typeof scope['object'] === 'string' &&
      UUID.test(scope['object'])
    )
  ) {
    problems.push({
      code: 'invalid_value',
      path: `${path}.scope`,
      message: 'scope is "organization" or { object: <uuid> }',
    });
  }
  const resources = raw['resources'];
  const seen = new Set<string>();
  if (resources !== undefined) {
    if (!Array.isArray(resources)) {
      problems.push({
        code: 'invalid_value',
        path: `${path}.resources`,
        message: 'resources is a list',
      });
    } else {
      resources.forEach((resource, i) => {
        const at = `${path}.resources[${String(i)}]`;
        if (!isRecord(resource)) {
          problems.push({
            code: 'invalid_value',
            path: at,
            message: 'a resource is referenced by { id, revision, authority_class }, never copied',
          });
          return;
        }
        closedKeys(resource, RESOURCE_KEYS, at, problems);
        if (typeof resource['id'] !== 'string' || !UUID.test(resource['id'])) {
          problems.push({
            code: 'dead_reference',
            path: `${at}.id`,
            message: 'a resource is referenced by its identifier',
          });
        } else if (seen.has(resource['id'])) {
          problems.push({
            code: 'duplicate_requirement',
            path: `${at}.id`,
            message: `resource ${resource['id']} is listed twice`,
          });
        } else seen.add(resource['id']);
        if (!text(resource['revision'])) {
          problems.push({
            code: 'missing_field',
            path: `${at}.revision`,
            message: 'a resource is referenced at a revision',
          });
        }
        if (!AUTHORITY_CLASSES.includes(resource['authority_class'] as AuthorityClass)) {
          problems.push({
            code: 'missing_field',
            path: `${at}.authority_class`,
            message: `authority_class is one of ${AUTHORITY_CLASSES.join(', ')}`,
          });
        }
      });
    }
  }
  if (mode === 'acknowledge' && seen.size === 0) {
    problems.push({
      code: 'missing_field',
      path: `${path}.resources`,
      message: 'an acknowledgement names the resource that is received and reviewed',
    });
  }
  stringList(raw['prerequisites'], `${path}.prerequisites`, KEY, problems);
  stringList(raw['gates'], `${path}.gates`, ACTION, problems);
  stringList(raw['equivalent_to'], `${path}.equivalent_to`, KEY, problems);
  stringList(raw['formats'], `${path}.formats`, /^[a-z][a-z_]{0,31}$/, problems);
  return problems.length === before ? (raw as unknown as RequirementDocument) : undefined;
}

/** Whether the prerequisite graph over `requirements` has a cycle; returns one if it does. */
function prerequisiteCycle(requirements: readonly ComposedRequirement[]): string[] | undefined {
  const edges = new Map(requirements.map((r) => [r.key, r.definition.prerequisites ?? []]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];
  const visit = (key: string): string[] | undefined => {
    if (state.get(key) === 'done') return undefined;
    if (state.get(key) === 'visiting') return [...stack.slice(stack.indexOf(key)), key];
    state.set(key, 'visiting');
    stack.push(key);
    for (const next of edges.get(key) ?? []) {
      if (!edges.has(next)) continue;
      const cycle = visit(next);
      if (cycle !== undefined) return cycle;
    }
    stack.pop();
    state.set(key, 'done');
    return undefined;
  };
  for (const key of [...edges.keys()].sort()) {
    const cycle = visit(key);
    if (cycle !== undefined) return cycle;
  }
  return undefined;
}

export interface PackValidation {
  readonly problems: readonly PackProblem[];
  /** The document, typed, when it parsed; problems may still refuse it. */
  readonly document?: PackDocument;
  /** The flattened composition: every requirement once, own and composed. */
  readonly composition: readonly ComposedRequirement[];
}

/**
 * Validate a pack document and compose it with its parts. `parts` resolves a part reference to
 * what the caller knows of that pack; absent means no such pack (a dead reference).
 */
export function validatePackDocument(
  raw: unknown,
  parts: (ref: PartRef) => ResolvedPart | undefined = () => undefined,
): PackValidation {
  const problems: PackProblem[] = [];
  if (!isRecord(raw)) {
    return {
      problems: [{ code: 'format', path: '$', message: 'a pack document is an object' }],
      composition: [],
    };
  }
  closedKeys(raw, PACK_KEYS, '$', problems);
  if (raw['format'] !== PACK_FORMAT) {
    problems.push({ code: 'format', path: '$.format', message: `format is ${PACK_FORMAT}` });
  }
  if (typeof raw['key'] !== 'string' || !PACK_KEY.test(raw['key'])) {
    problems.push({ code: 'missing_field', path: '$.key', message: 'a pack has a stable key' });
  }
  if (!positiveInteger(raw['revision'])) {
    problems.push({
      code: 'missing_field',
      path: '$.revision',
      message: 'a pack names its revision, a positive integer',
    });
  }
  if (!text(raw['title'])) {
    problems.push({ code: 'missing_field', path: '$.title', message: 'a pack has a title' });
  }
  if (typeof raw['owner'] !== 'string' || !ROLE_AUTHORITY.test(raw['owner'])) {
    problems.push({
      code: 'missing_owner',
      path: '$.owner',
      message: 'a pack names who maintains it: role:<role>',
    });
  }
  if (!CLOSING_RULES.includes(raw['closing'] as ClosingRule)) {
    problems.push({
      code: 'missing_field',
      path: '$.closing',
      message: `closing is one of ${CLOSING_RULES.join(', ')}: the pack's standing rule`,
    });
  }
  const acceptor = raw['acceptor'];
  if (raw['closing'] === 'on_acceptance') {
    if (typeof acceptor !== 'string' || !ROLE_AUTHORITY.test(acceptor)) {
      problems.push({
        code: 'missing_owner',
        path: '$.acceptor',
        message: 'a pack closed on acceptance names its acceptor: role:<role>',
      });
    }
  } else if (acceptor !== undefined) {
    problems.push({
      code: 'invalid_value',
      path: '$.acceptor',
      message: 'an acceptor is named only by a pack closed on acceptance',
    });
  }

  const composition = new Map<string, ComposedRequirement>();
  const sources = new Map<string, string>();
  const add = (requirement: ComposedRequirement, source: string, path: string) => {
    const existing = composition.get(requirement.key);
    if (existing === undefined) {
      composition.set(requirement.key, requirement);
      sources.set(requirement.key, source);
      return;
    }
    if (existing.revision !== requirement.revision || existing.digest !== requirement.digest) {
      problems.push({
        code: 'conflicting_requirement',
        path,
        message:
          `requirement ${requirement.key} is revision ${String(existing.revision)} in ` +
          `${sources.get(requirement.key) ?? '?'} and revision ${String(requirement.revision)} ` +
          `in ${source}, or the two disagree; a shared requirement is one requirement`,
      });
    }
    // Identical: one requirement, satisfied once (decision 3).
  };

  // Parts first, in the order listed: common, role, scope.
  const partsRaw = raw['parts'];
  if (partsRaw !== undefined) {
    if (!isRecord(partsRaw)) {
      problems.push({
        code: 'invalid_value',
        path: '$.parts',
        message: 'parts is { common, role, scope }, each an explicit list of { pack, revision }',
      });
    } else {
      closedKeys(partsRaw, PARTS_KEYS, '$.parts', problems);
      for (const part of PARTS) {
        const list = partsRaw[part];
        if (list === undefined) continue;
        if (!Array.isArray(list)) {
          problems.push({
            code: 'invalid_value',
            path: `$.parts.${part}`,
            message: `parts.${part} is a list`,
          });
          continue;
        }
        list.forEach((ref, i) => {
          const at = `$.parts.${part}[${String(i)}]`;
          if (!isRecord(ref)) {
            problems.push({
              code: 'invalid_value',
              path: at,
              message: 'a part is { pack, revision }',
            });
            return;
          }
          closedKeys(ref, PART_REF_KEYS, at, problems);
          if (
            typeof ref['pack'] !== 'string' ||
            !PACK_KEY.test(ref['pack']) ||
            !positiveInteger(ref['revision'])
          ) {
            problems.push({
              code: 'dead_reference',
              path: at,
              message: 'a part names a pack by key and revision',
            });
            return;
          }
          const partRef: PartRef = { pack: ref['pack'], revision: ref['revision'] };
          if (partRef.pack === raw['key']) {
            problems.push({
              code: 'composition_cycle',
              path: at,
              message: `pack ${partRef.pack} composes itself`,
            });
            return;
          }
          const resolved = parts(partRef);
          if (resolved === undefined) {
            problems.push({
              code: 'dead_reference',
              path: at,
              message: `no pack ${partRef.pack} at revision ${String(partRef.revision)}`,
            });
            return;
          }
          if (!resolved.approved) {
            problems.push({
              code: 'dead_reference',
              path: at,
              message: `pack ${partRef.pack} revision ${String(partRef.revision)} is not approved`,
            });
            return;
          }
          if (resolved.composesParts) {
            problems.push({
              code: 'nested_composition',
              path: at,
              message:
                `pack ${partRef.pack} composes parts of its own; a part is composed by one ` +
                'explicit list, never by a chain',
            });
            return;
          }
          for (const requirement of resolved.requirements) {
            if (requirement.via !== undefined) {
              problems.push({
                code: 'nested_composition',
                path: at,
                message: `pack ${partRef.pack} carries composed requirements`,
              });
              return;
            }
          }
          for (const requirement of resolved.requirements) {
            add(
              { ...requirement, part, via: partRef },
              `${partRef.pack}@${String(partRef.revision)}`,
              at,
            );
          }
        });
      }
    }
  }

  // The pack's own requirements.
  const own = raw['requirements'];
  const ownKeys = new Set<string>();
  if (!Array.isArray(own)) {
    problems.push({
      code: 'missing_field',
      path: '$.requirements',
      message: 'requirements is a list (it may be empty for a pack composed only of parts)',
    });
  } else {
    own.forEach((rawRequirement, i) => {
      const at = `$.requirements[${String(i)}]`;
      // A key declared twice is refused whether or not either declaration is otherwise valid.
      const rawKey = isRecord(rawRequirement) ? rawRequirement['key'] : undefined;
      if (typeof rawKey === 'string') {
        if (ownKeys.has(rawKey)) {
          problems.push({
            code: 'duplicate_requirement',
            path: `${at}.key`,
            message: `requirement ${rawKey} is declared twice in this pack`,
          });
          return;
        }
        ownKeys.add(rawKey);
      }
      const requirement = validateRequirement(rawRequirement, at, problems);
      if (requirement === undefined) return;
      const definition = requirementDefinition(requirement);
      add(
        {
          key: requirement.key,
          revision: requirement.revision,
          part: requirement.part,
          definition,
          digest: requirementDigest(definition),
        },
        'this pack',
        at,
      );
    });
  }

  const composed = [...composition.values()].sort((a, b) => a.key.localeCompare(b.key));
  const keys = new Set(composed.map((r) => r.key));
  for (const requirement of composed) {
    for (const prerequisite of requirement.definition.prerequisites ?? []) {
      if (!keys.has(prerequisite)) {
        problems.push({
          code: 'dead_reference',
          path: `requirement ${requirement.key}`,
          message: `prerequisite ${prerequisite} is not a requirement of this pack`,
        });
      }
    }
  }
  const cycle = prerequisiteCycle(composed);
  if (cycle !== undefined) {
    problems.push({
      code: 'prerequisite_cycle',
      path: `requirement ${cycle[0] ?? '?'}`,
      message: `prerequisites form a cycle: ${cycle.join(' → ')}`,
    });
  }
  if (Array.isArray(own) && own.length === 0 && composed.length === 0) {
    problems.push({
      code: 'missing_field',
      path: '$.requirements',
      message: 'a pack requires something: it has no requirement and composes none',
    });
  }

  return {
    problems,
    ...(problems.length === 0 ? { document: raw as unknown as PackDocument } : {}),
    composition: composed,
  };
}

/** The validator's problems as one sentence, for a refusal. */
export function describeProblems(problems: readonly PackProblem[]): string {
  return problems.map((p) => `${p.code} at ${p.path}: ${p.message}`).join('; ');
}
