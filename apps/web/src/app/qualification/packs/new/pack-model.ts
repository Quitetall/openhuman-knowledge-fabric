/**
 * The pack-drafting form's model: what a person fills in, and the `kf-qualification-pack-v1`
 * document it spells (ADR 0038 decisions 3 to 5; KF-SAS-RQ-255, RQ-256, RQ-260).
 *
 * Pure and dependency-free, so the browser builds the document as the person types and shows it,
 * and the server action rebuilds nothing: it receives the document and validates it with
 * `@kf/qualification`'s own `validatePackDocument`. Nothing here judges the document. A value the
 * form cannot spell as the schema wants (a revision that is not a number) is passed through as
 * typed, so the validator names it rather than this module quietly dropping it.
 *
 * The field lists below are the document's closed vocabulary, repeated for the form's choices.
 * `pack-model.test.ts` holds them equal to the validator's own constants, so the form cannot offer
 * a value the validator refuses or omit one it accepts.
 */

export const DRAFT_STAGES = [
  'read_in',
  'role_read_in',
  'references',
  'execution',
  'first_contribution',
] as const;
export const DRAFT_MODES = ['acknowledge', 'locate', 'demonstrate'] as const;
export const DRAFT_PARTS = ['common', 'role', 'scope'] as const;
export const DRAFT_CONSEQUENCES = ['unsafe', 'unauthorized', 'unreliable'] as const;
export const DRAFT_CLOSING = ['on_evidence', 'on_acceptance'] as const;
export const DRAFT_AUTHORITY_CLASSES = ['normative', 'reference', 'learning'] as const;

export const STAGE_LABELS: Readonly<Record<(typeof DRAFT_STAGES)[number], string>> = {
  read_in: 'Read-In: what have I joined',
  role_read_in: 'Role Read-In: what is my place in it',
  references: 'References: where authoritative truth lives',
  execution: 'Execution: how work moves here',
  first_contribution: 'First Contribution: bounded, useful work',
};

export const MODE_LABELS: Readonly<Record<(typeof DRAFT_MODES)[number], string>> = {
  acknowledge: 'Acknowledge: received and reviewed',
  locate: 'Locate: knows where it lives and when to use it',
  demonstrate: 'Demonstrate: accepted work shows it',
};

/** Who accepts a requirement: the person themself, their contact, or holders of a role. */
export type AcceptedByKind = 'self' | 'contact' | 'role';

export interface RequirementDraft {
  readonly key: string;
  readonly revision: string;
  readonly part: string;
  readonly stage: string;
  readonly outcome: string;
  readonly evidenceMode: string;
  readonly acceptedByKind: AcceptedByKind;
  readonly acceptedByRole: string;
  readonly mandatory: boolean;
  readonly consequenceKind: string;
  readonly consequenceStatement: string;
  /** '' when undeclared (only a first revision may leave it so), else 'true' or 'false'. */
  readonly behaviouralImpact: '' | 'true' | 'false';
  /** '' for the organization, else one scope object's id. */
  readonly scopeObject: string;
  /** One per line: `<id> <revision> <authority class> [label…]`. */
  readonly resources: string;
  readonly prerequisites: string;
  readonly gates: string;
  readonly equivalentTo: string;
  readonly formats: string;
}

export interface PackDraft {
  readonly key: string;
  readonly title: string;
  readonly ownerRole: string;
  readonly closing: string;
  readonly acceptorRole: string;
  /** Each a list of `<pack key>@<revision>`, separated by spaces, commas or new lines. */
  readonly parts: Readonly<Record<(typeof DRAFT_PARTS)[number], string>>;
  readonly requirements: readonly RequirementDraft[];
}

export function emptyRequirement(): RequirementDraft {
  return {
    key: '',
    revision: '1',
    part: 'role',
    stage: 'read_in',
    outcome: '',
    evidenceMode: 'acknowledge',
    acceptedByKind: 'self',
    acceptedByRole: '',
    mandatory: true,
    consequenceKind: 'unreliable',
    consequenceStatement: '',
    behaviouralImpact: '',
    scopeObject: '',
    resources: '',
    prerequisites: '',
    gates: '',
    equivalentTo: '',
    formats: '',
  };
}

export function emptyPack(): PackDraft {
  return {
    key: '',
    title: '',
    ownerRole: '',
    closing: 'on_evidence',
    acceptorRole: '',
    parts: { common: '', role: '', scope: '' },
    requirements: [emptyRequirement()],
  };
}

function words(text: string): string[] {
  return text
    .split(/[\s,]+/u)
    .map((w) => w.trim())
    .filter((w) => w !== '');
}

/** A positive integer when the text is one; otherwise the text, for the validator to name. */
function integer(text: string): number | string {
  const trimmed = text.trim();
  return /^[0-9]{1,9}$/u.test(trimmed) ? Number(trimmed) : trimmed;
}

function role(id: string): string {
  return `role:${id.trim()}`;
}

function resourceLines(text: string): Record<string, unknown>[] {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [id = '', revision = '', authorityClass = '', ...label] = line.split(/\s+/u);
      return {
        id,
        revision,
        authority_class: authorityClass,
        ...(label.length === 0 ? {} : { label: label.join(' ') }),
      };
    });
}

function partRefs(text: string): Record<string, unknown>[] {
  return words(text).map((ref) => {
    const at = ref.lastIndexOf('@');
    return at <= 0
      ? { pack: ref, revision: '' }
      : { pack: ref.slice(0, at), revision: integer(ref.slice(at + 1)) };
  });
}

/** One requirement as the document spells it. Optional fields left empty are omitted. */
export function requirementDocument(r: RequirementDraft): Record<string, unknown> {
  const list = (name: string, text: string) => {
    const items = words(text);
    return items.length === 0 ? {} : { [name]: items };
  };
  const resources = resourceLines(r.resources);
  const statement = r.consequenceStatement.trim();
  return {
    key: r.key.trim(),
    revision: integer(r.revision),
    part: r.part,
    stage: r.stage,
    outcome: r.outcome.trim(),
    evidence_mode: r.evidenceMode,
    accepted_by: r.acceptedByKind === 'role' ? role(r.acceptedByRole) : r.acceptedByKind,
    mandatory: r.mandatory,
    // A mandatory requirement names its consequence; an optional one may, if it says something.
    ...(r.mandatory || statement !== ''
      ? { consequence: { kind: r.consequenceKind, statement: statement } }
      : {}),
    ...(r.behaviouralImpact === '' ? {} : { behavioural_impact: r.behaviouralImpact === 'true' }),
    ...(r.scopeObject.trim() === '' ? {} : { scope: { object: r.scopeObject.trim() } }),
    ...(resources.length === 0 ? {} : { resources }),
    ...list('prerequisites', r.prerequisites),
    ...list('gates', r.gates),
    ...list('equivalent_to', r.equivalentTo),
    ...list('formats', r.formats),
  };
}

/** The whole document. A new pack is always revision 1: a later one is a supersession. */
export function packDocument(draft: PackDraft): Record<string, unknown> {
  const parts: Record<string, unknown> = {};
  for (const part of DRAFT_PARTS) {
    const refs = partRefs(draft.parts[part]);
    if (refs.length > 0) parts[part] = refs;
  }
  return {
    format: 'kf-qualification-pack-v1',
    key: draft.key.trim(),
    revision: 1,
    title: draft.title.trim(),
    owner: role(draft.ownerRole),
    closing: draft.closing,
    ...(draft.closing === 'on_acceptance' ? { acceptor: role(draft.acceptorRole) } : {}),
    ...(Object.keys(parts).length === 0 ? {} : { parts }),
    requirements: draft.requirements.map(requirementDocument),
  };
}
