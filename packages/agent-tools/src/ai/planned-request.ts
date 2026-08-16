import type { AiProposalRequest } from './types.js';

const PLANNED_AI_REQUESTS = new WeakSet<AiProposalRequest>();

export function markPlannedRequest(request: AiProposalRequest): AiProposalRequest {
  const planned = { ...request };
  PLANNED_AI_REQUESTS.add(planned);
  return Object.freeze(planned);
}

export function isPlannedRequest(request: AiProposalRequest): boolean {
  return PLANNED_AI_REQUESTS.has(request);
}
