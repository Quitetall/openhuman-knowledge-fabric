/**
 * The agent guide: the seam M4's in-app chat plugs into (ADR 0040 decision 12; ADR 0038 decision
 * 10; KF-WAR-0007 deliverable 7).
 *
 * This module does not hold a conversation. It defines what a chat is GIVEN when it guides a
 * person through Start Here, and what it may and may not do with it, so that M4 (KF-WAR-0006)
 * builds the chat and this milestone owns the rules:
 *
 *   - the context: the person's Start Here (generated from their record, never edited), the
 *     requirements to work on next in protocol order, their named contact, and the closed list of
 *     what the guide may do;
 *   - the rules, as text the chat places in its system prompt verbatim: explain, answer from the
 *     record, point at references, assemble a submission and check its fields — and never infer
 *     competence, never credit evidence, never accept, never grant. The database refuses an
 *     agent's credit or acceptance whatever the prompt says (KF-QUAL-011); the prompt is so the
 *     guide does not offer what it cannot do.
 *
 * The one write a guide may help with is `submit_qualification_evidence`, for its person, which
 * names a record as evidence and credits nothing: a reviewer decides from Needs you.
 *
 * `AgentGuide` is the interface M4 implements against; `GET /start-here/guide` serves the
 * context for the bound reader's open record, and `agentGuideContext` builds it from a Start Here.
 */

import type { StartHere, StartHereItem } from './start-here.js';
import { STAGES, type Stage } from './pack.js';

export const AGENT_GUIDE_FORMAT = 'kf-agent-guide-context-v1' as const;

/** What a guide may do: explain and assemble. */
export const GUIDE_MAY = [
  'explain_a_stage_or_requirement',
  'answer_from_the_record_with_citations',
  'point_at_references_and_their_authority_class',
  'assemble_a_submission_and_check_its_fields',
  'submit_evidence_for_its_person',
] as const;

/** What a guide never does (ADR 0038 decision 10). The database refuses each regardless. */
export const GUIDE_MAY_NOT = [
  'infer_competence',
  'credit_evidence',
  'accept_a_qualification',
  'grant_anything',
  'mark_anything_read_on_the_person_s_behalf',
] as const;

/** The acts a guide may dispatch for its person. Closed. */
export const GUIDE_ACTS = ['submit_qualification_evidence'] as const;

export interface AgentGuideNext {
  readonly key: string;
  readonly stage: Stage;
  readonly outcome: string;
  readonly mode: StartHereItem['mode'];
  readonly status: StartHereItem['status'];
  readonly acceptedBy: string;
  /** Prerequisites still open: suggest those first. */
  readonly awaiting: readonly string[];
  /** For a blocker: say it is the organization's, and who to tell. */
  readonly blockedOnOrganization: boolean;
}

export interface AgentGuideContext {
  readonly format: typeof AGENT_GUIDE_FORMAT;
  readonly personId: string;
  readonly recordId: string;
  /** The Start Here the guide is given, with its digest: what the person sees. */
  readonly startHere: StartHere;
  /** The open requirements in protocol order, prerequisites before what awaits them. */
  readonly next: readonly AgentGuideNext[];
  readonly contact: StartHere['contact'];
  readonly may: typeof GUIDE_MAY;
  readonly mayNot: typeof GUIDE_MAY_NOT;
  readonly acts: typeof GUIDE_ACTS;
  /** The rules as text, for the chat's system prompt, verbatim. */
  readonly instructions: string;
}

/**
 * What M4's chat implements to guide: given the bound reader, the context to seed the
 * conversation with. A chat that guides calls `context` once per conversation and again after
 * any act, and shows the Start Here digest it was given.
 */
export interface AgentGuide {
  context(reader: {
    readonly actorId: string;
    readonly organizationId: string;
  }): Promise<AgentGuideContext | undefined>;
}

export function guideInstructions(page: StartHere): string {
  const contact = page.contact.name ?? 'your named contact';
  return [
    `You are guiding a person through "Start Here" for ${page.pack.title} (revision ${String(page.pack.revision)}).`,
    'The five stages are the same for everyone: Read-In, Role Read-In, References, Execution, First Contribution.',
    'You may explain any stage or requirement, answer from the record citing what you used, point at references and say whether each is normative, reference or learning, and help assemble a submission of evidence and check its fields.',
    'You never infer competence, never credit evidence, never accept a qualification, never grant access and never mark anything read for the person. A reviewer holding the authority a requirement names credits it from Needs you; the database refuses an agent that tries.',
    'Opening a document establishes nothing unless the requirement says acknowledgement is the outcome. Acknowledged is never demonstrated.',
    `Anything blocked on the organization — a resource the person cannot read, or nobody to accept the evidence — is the organization's to fix, never the person's failure: say so, and point them at ${contact}.`,
    'The test is real work: the First Contribution is a small, bounded Warrant the person finishes with your help, and its acceptance credits the requirements it evidences.',
  ].join('\n');
}

/** Build the guide's context from a Start Here. Pure. */
export function agentGuideContext(page: StartHere): AgentGuideContext {
  const order = new Map(STAGES.map((stage, i) => [stage, i]));
  const open = page.stages
    .flatMap((stage) => stage.items.map((item) => ({ stage: stage.id, item })))
    .filter(({ item }) => item.status !== 'satisfied')
    .sort(
      (a, b) =>
        a.item.awaiting.length - b.item.awaiting.length ||
        (order.get(a.stage) ?? 0) - (order.get(b.stage) ?? 0) ||
        a.item.key.localeCompare(b.item.key),
    );
  return {
    format: AGENT_GUIDE_FORMAT,
    personId: page.personId,
    recordId: page.recordId,
    startHere: page,
    next: open.map(({ stage, item }) => ({
      key: item.key,
      stage,
      outcome: item.outcome,
      mode: item.mode,
      status: item.status,
      acceptedBy: item.acceptedBy,
      awaiting: item.awaiting,
      blockedOnOrganization: item.status === 'blocked_on_organization',
    })),
    contact: page.contact,
    may: GUIDE_MAY,
    mayNot: GUIDE_MAY_NOT,
    acts: GUIDE_ACTS,
    instructions: guideInstructions(page),
  };
}
