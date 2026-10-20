/**
 * Who writes answers here, in the words a person reads (the AI answers page, the answer cards, the
 * no-model notice). Pure: everything here is decided from the deployment's agent configuration
 * (config.ts) and the organization's provider ceiling (`GET /model-routing`), so a test proves each
 * sentence without a server.
 *
 * Two separate decisions, and the page says both:
 *
 *   - the DEPLOYMENT's: which models exist here: none, one on this computer, a cloud model, or both
 *     (KF_AGENT_*; on one's own computer, the workspace's AI answers page sets it);
 *   - the ORGANIZATION's: what may leave this computer for a cloud model at all, its provider
 *     ceiling, changed only by `set_model_routing_policy`, an institutional act the person performs
 *     here with one button (ADR 0040 decision 8, KF-SAS-RQ-271).
 *
 * `routingAdvice` never proposes a ceiling above `internal`: confidential and restricted content is
 * answered on this computer or not at all, whatever anyone chooses, and the database refuses more
 * (KF-ROUTE-001).
 */

import type { ProviderCeiling } from '@kf/agent';

export type AnswersChoice = 'off' | 'on_host' | 'cloud' | 'both';

export interface AnswersSetting {
  readonly choice: AnswersChoice;
  /** The cloud provider's name, when there is one: `Anthropic`, `OpenAI`, … */
  readonly cloudName?: string;
}

/** Where to turn AI answers on, or change them. */
export const AI_ANSWERS_PATH = '/ai-answers';

export function answersSetting(config: {
  readonly lamu?: unknown;
  readonly provider?: { readonly name: string } | undefined;
}): AnswersSetting {
  const onHost = config.lamu !== undefined;
  const cloud = config.provider;
  if (cloud === undefined) return { choice: onHost ? 'on_host' : 'off' };
  return { choice: onHost ? 'both' : 'cloud', cloudName: cloud.name };
}

export function settingWords(setting: AnswersSetting): string {
  const cloud = `Cloud model (${setting.cloudName ?? 'not named'})`;
  switch (setting.choice) {
    case 'off':
      return 'Off: Knowledge Fabric searches, but no model writes answers.';
    case 'on_host':
      return 'On this computer: a model on this computer writes every answer; nothing leaves it.';
    case 'cloud':
      return `${cloud}: answers come from the cloud model, and only from records your organization lets leave this computer. Questions about other records are not answered.`;
    case 'both':
      return `Both: ${cloud} for records your organization lets leave this computer; the model on this computer for everything else.`;
  }
}

export function ceilingWords(ceiling: ProviderCeiling): string {
  switch (ceiling) {
    case 'none':
      return 'Nothing leaves this computer: no cloud model is sent anything, not even a question.';
    case 'public':
      return 'Only records marked public may be sent to a cloud model.';
    case 'internal':
      return 'Records marked public or internal may be sent to a cloud model. Confidential and restricted records never are.';
  }
}

/** Which model wrote an answer, in plain words (KF-SAS-RQ-272: every answer names its backend). */
export function answeredBy(
  backend: { readonly kind: 'on_host' | 'provider'; readonly name: string } | null,
): string {
  if (backend === null) return 'No model wrote this; nothing was sent to one.';
  return backend.kind === 'on_host'
    ? 'Answered on this computer'
    : `Answered by a cloud model: ${backend.name}`;
}

/**
 * What the AI answers button may ask for, from a submitted form value: `none` or `internal`, with
 * the act's reason and the sentence shown after. Anything else is undefined and nothing is sent, so
 * a crafted form cannot ask this application to send `confidential` or `restricted` (the API and
 * the database refuse those too, KF-ROUTE-001).
 */
export function routingRequest(
  value: unknown,
): { ceiling: 'none' | 'internal'; reason: string; done: string } | undefined {
  if (value === 'internal') {
    return {
      ceiling: 'internal',
      reason:
        'AI answers: a cloud model may answer from records cleared to leave (public, internal)',
      done: 'Recorded: public and internal records may go to the cloud model.',
    };
  }
  if (value === 'none') {
    return {
      ceiling: 'none',
      reason: 'AI answers: answers are written on this computer only, so nothing leaves it',
      done: 'Recorded: nothing leaves this computer.',
    };
  }
  return undefined;
}

export interface RoutingAdvice {
  /** The ceiling the button sets: never above `internal`. */
  readonly ceiling: 'none' | 'internal';
  readonly button: string;
  readonly why: string;
}

/**
 * Whether the organization's ceiling fits who writes answers here, and if not, the one change that
 * would. Undefined when it fits (or when nothing answers, so nothing depends on it).
 */
export function routingAdvice(
  setting: AnswersSetting,
  ceiling: ProviderCeiling,
): RoutingAdvice | undefined {
  const cloud = setting.choice === 'cloud' || setting.choice === 'both';
  if (cloud && ceiling === 'none') {
    return {
      ceiling: 'internal',
      button: 'Let public and internal records go to the cloud model',
      why:
        `${setting.cloudName ?? 'A cloud model'} is set up here, but your organization lets ` +
        'nothing leave this computer, so it is never asked. Confidential and restricted records ' +
        'stay on this computer either way.',
    };
  }
  if (setting.choice === 'on_host' && ceiling !== 'none') {
    return {
      ceiling: 'none',
      button: 'Keep everything on this computer',
      why:
        'Answers are written on this computer. Your organization would still let some records ' +
        'go to a cloud model if one were added later; this makes that its decision again.',
    };
  }
  return undefined;
}
