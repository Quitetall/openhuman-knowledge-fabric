import type { OpenWarrantSubmission } from '@kf/warrants';

export const valid: OpenWarrantSubmission = {
  attempt_id: 'attempt-1',
  contract_digest: 'digest',
  dispatch_id: 'dispatch-1',
  stage_id: 'build',
  requested_next_action: 'verify',
};
// @ts-expect-error Required dispatch identity cannot disappear.
export const missing: OpenWarrantSubmission = { attempt_id: 'attempt-1' };
// @ts-expect-error Unknown next action is not a portable submission.
export const invalid: OpenWarrantSubmission = { ...valid, requested_next_action: 'ship' };
// @ts-expect-error References must be strings.
export const badReferences: OpenWarrantSubmission = { ...valid, artifact_refs: [42] };
