/**
 * The closed list of acts an agent may write for its person (ADR 0040, SAS §82, KF-SAS-RQ-020,
 * RQ-263 to RQ-266).
 *
 * §82 said a general write tool would be an authority change; ADR 0040 is that change, and keeps
 * the guarantee by making the list closed. An agent names one of these acts and nothing else: there
 * is no act type the caller supplies. Each entry states the fields a person would fill for it
 * (RQ-266), so an agent's draft and a person's form are one shape, and how the agent's write
 * lands:
 *
 *   - `submit`  — the act is performed for the person, recorded with the agent's participation,
 *                 and the record it writes is UNVERIFIED until a person with authority verifies it
 *                 or a verification policy in force does (RQ-263);
 *   - `propose` — the act is institutional, so the agent can only propose it: `propose_act`
 *                 records it and performs nothing, and it waits in the person's Needs you until
 *                 they perform it themselves (RQ-265).
 *
 * Which acts are institutional is the ontology's (`requires: act`), and the database refuses an
 * agent performing one whatever this list says (KF-AGENT-001). This list only narrows: an act
 * missing from it is not reachable through an agent surface at all.
 *
 * Pure data, no I/O: the MCP server, the in-app agent (M4) and the web form share it.
 */

export type AgentActDisposition = 'submit' | 'propose';

export type AgentFieldKind =
  'text' | 'uuid' | 'uuid_list' | 'text_list' | 'instant' | 'classification';

export interface AgentField {
  readonly name: string;
  readonly kind: AgentFieldKind;
  readonly required: boolean;
  /** What a person filling the form is told the field is for. */
  readonly label: string;
  /** Upper bound on a text field's length, in characters. */
  readonly maxLength?: number;
}

export interface AgentAct {
  readonly act: string;
  readonly disposition: AgentActDisposition;
  /** Where it lands: the capture seam (one gesture, ADR 0034) or `POST /actions/:act`. */
  readonly route: 'capture' | 'action';
  readonly title: string;
  readonly description: string;
  /** How many existing records it acts on: none (it creates one), or exactly one. */
  readonly targets: 'none' | 'one';
  /** What kind the target must be, when it has one. */
  readonly targetKind?: string;
  /** The record kind it creates, when it creates one. */
  readonly creates?: string;
  readonly reasonRequired: boolean;
  readonly fields: readonly AgentField[];
}

const CLASSIFICATION: AgentField = {
  name: 'classification',
  kind: 'classification',
  required: false,
  label:
    'Classification (public, internal, confidential, restricted); defaults to the record kind’s',
};

export const AGENT_ACTS: readonly AgentAct[] = [
  {
    act: 'record_observation',
    disposition: 'submit',
    route: 'capture',
    title: 'Record an observation',
    description:
      'Capture something that happened, in one gesture (ADR 0034). Lands captured and unverified.',
    targets: 'none',
    creates: 'observation',
    reasonRequired: false,
    fields: [
      { name: 'body', kind: 'text', required: true, label: 'What was observed', maxLength: 65536 },
      {
        name: 'subjects',
        kind: 'uuid_list',
        required: false,
        label: 'Records it concerns (ids you can read)',
      },
      { name: 'tags', kind: 'text_list', required: false, label: 'Tags' },
      {
        name: 'observed_at',
        kind: 'instant',
        required: false,
        label: 'When it was observed (RFC 3339); defaults to now',
      },
    ],
  },
  {
    act: 'propose_decision',
    disposition: 'submit',
    route: 'action',
    title: 'Draft a decision record',
    description: 'Open a decision record in draft. Accepting it is institutional and separate.',
    targets: 'none',
    creates: 'decision_record',
    reasonRequired: false,
    fields: [
      { name: 'title', kind: 'text', required: true, label: 'Decision title', maxLength: 240 },
      CLASSIFICATION,
    ],
  },
  {
    act: 'create_initiative',
    disposition: 'submit',
    route: 'action',
    title: 'Propose an initiative',
    description: 'Open an initiative in its first state. Authorizing it is institutional.',
    targets: 'none',
    creates: 'initiative_project',
    reasonRequired: false,
    fields: [
      { name: 'title', kind: 'text', required: true, label: 'Initiative title', maxLength: 240 },
      { name: 'objective', kind: 'text', required: true, label: 'What it is for', maxLength: 4000 },
      { name: 'sponsor_id', kind: 'uuid', required: true, label: 'Sponsor (a person id)' },
      { name: 'project_code', kind: 'text', required: false, label: 'Project code', maxLength: 64 },
      CLASSIFICATION,
    ],
  },
  {
    act: 'withdraw_observation',
    disposition: 'submit',
    route: 'action',
    title: 'Withdraw an observation',
    description: 'Retire an observation nobody should rely on. The withdrawal is itself recorded.',
    targets: 'one',
    targetKind: 'observation',
    reasonRequired: true,
    fields: [],
  },
  {
    act: 'promote_observation',
    disposition: 'propose',
    route: 'action',
    title: 'Promote an observation (proposed; your person confirms)',
    description:
      'Institutional: the agent proposes it, and it waits in Needs you for the person to perform.',
    targets: 'one',
    targetKind: 'observation',
    reasonRequired: true,
    fields: [
      {
        name: 'promoted_to',
        kind: 'uuid_list',
        required: false,
        label: 'Records it became (each will be derived_from it)',
      },
    ],
  },
  {
    act: 'accept_decision',
    disposition: 'propose',
    route: 'action',
    title: 'Accept a decision (proposed; your person confirms)',
    description: 'Institutional: proposed by the agent, performed by the person from Needs you.',
    targets: 'one',
    targetKind: 'decision_record',
    reasonRequired: true,
    fields: [],
  },
  {
    act: 'reject_decision',
    disposition: 'propose',
    route: 'action',
    title: 'Reject a decision (proposed; your person confirms)',
    description: 'Institutional: proposed by the agent, performed by the person from Needs you.',
    targets: 'one',
    targetKind: 'decision_record',
    reasonRequired: true,
    fields: [],
  },
];

/** The closed list's names, for a schema enum. */
export const AGENT_ACT_NAMES = AGENT_ACTS.map((entry) => entry.act) as readonly string[];

export function agentAct(act: string): AgentAct | undefined {
  return AGENT_ACTS.find((entry) => entry.act === act);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const CLASSIFICATIONS = ['public', 'internal', 'confidential', 'restricted'];

export interface AgentDraftField {
  readonly name: string;
  readonly label: string;
  readonly required: boolean;
  readonly value: unknown;
  /** Why the value cannot be used, or that a required one is missing. */
  readonly problem?: string;
}

export interface AgentDraft {
  readonly act: string;
  readonly disposition: AgentActDisposition;
  readonly title: string;
  readonly targetIds: readonly string[];
  readonly reason: string | null;
  readonly fields: readonly AgentDraftField[];
  /** Fields the act does not have, which a submission would refuse rather than drop. */
  readonly unknownFields: readonly string[];
  readonly problems: readonly string[];
  readonly ready: boolean;
  /** The payload a submission sends, the fields with values only. */
  readonly payload: Readonly<Record<string, unknown>>;
}

function fieldProblem(field: AgentField, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return field.required ? 'required' : undefined;
  }
  switch (field.kind) {
    case 'text':
      if (typeof value !== 'string' || value.trim() === '') return 'must be text';
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return `at most ${String(field.maxLength)} characters`;
      }
      return undefined;
    case 'uuid':
      return typeof value === 'string' && UUID.test(value) ? undefined : 'must be a record id';
    case 'uuid_list':
      return Array.isArray(value) && value.every((v) => typeof v === 'string' && UUID.test(v))
        ? undefined
        : 'must be a list of record ids';
    case 'text_list':
      return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim() !== '')
        ? undefined
        : 'must be a list of text';
    case 'instant':
      return typeof value === 'string' && INSTANT.test(value) ? undefined : 'must be RFC 3339';
    case 'classification':
      return typeof value === 'string' && CLASSIFICATIONS.includes(value)
        ? undefined
        : `must be one of ${CLASSIFICATIONS.join(', ')}`;
  }
}

/**
 * The form a person would fill for `act`, filled with what the agent proposes (RQ-266). Nothing
 * is written: a draft is shown to the person, and only a submission writes.
 */
export function draftAgentAct(
  act: AgentAct,
  input: {
    readonly targetIds?: readonly string[];
    readonly fields?: Readonly<Record<string, unknown>>;
    readonly reason?: string;
  },
): AgentDraft {
  const values = input.fields ?? {};
  const fields: AgentDraftField[] = act.fields.map((field) => {
    const problem = fieldProblem(field, values[field.name]);
    return {
      name: field.name,
      label: field.label,
      required: field.required,
      value: values[field.name] ?? null,
      ...(problem === undefined ? {} : { problem }),
    };
  });
  const unknownFields = Object.keys(values).filter(
    (name) => !act.fields.some((field) => field.name === name),
  );
  const targetIds = [...(input.targetIds ?? [])];
  const problems: string[] = [];
  if (act.targets === 'none' && targetIds.length > 0) {
    problems.push(`${act.act} creates its record and names no target`);
  }
  if (act.targets === 'one' && (targetIds.length !== 1 || !UUID.test(targetIds[0] ?? ''))) {
    problems.push(`${act.act} acts on exactly one ${act.targetKind ?? 'record'}: name its id`);
  }
  const reason = input.reason?.trim() ?? '';
  if (act.reasonRequired && reason.length < 8) {
    problems.push(`${act.act} needs a reason of at least 8 characters that says why`);
  }
  for (const field of fields) {
    if (field.problem !== undefined) problems.push(`${field.name}: ${field.problem}`);
  }
  for (const name of unknownFields) problems.push(`${name}: not a field of ${act.act}`);
  const payload = Object.fromEntries(
    act.fields
      .filter((field) => values[field.name] !== undefined && values[field.name] !== null)
      .map((field) => [field.name, values[field.name]]),
  );
  return {
    act: act.act,
    disposition: act.disposition,
    title: act.title,
    targetIds,
    reason: reason === '' ? null : reason,
    fields,
    unknownFields,
    problems,
    ready: problems.length === 0,
    payload,
  };
}
