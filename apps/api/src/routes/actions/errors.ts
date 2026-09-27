import { ActionRejected, asActionRefusal, type ActionFailure } from '@kf/actions';
import { DocumentParseRefused } from '@kf/documents';

/** How each refusal maps to a status code. */
const STATUS: Record<ActionFailure, number> = {
  unknown_action: 404,
  actor_not_authorized: 403,
  classification_not_granted: 403,
  role_not_held: 403,
  // The attestation lapsed (a minute) or never existed: identify again, as for a bad token.
  not_attested: 401,
  act_not_granted: 403,
  separation_of_duty: 403,
  object_not_visible: 404,
  version_conflict: 409,
  illegal_transition: 409,
  idempotency_conflict: 409,
  precondition_failed: 422,
  reason_required: 400,
};

/**
 * A source the parser declined — too slow, too much memory, too much output, or unparseable.
 *
 * 422 rather than 500: the document is the cause, and retrying the same bytes will be refused
 * the same way. The message is generic on purpose; pandoc's own stderr is logged by nothing
 * here and returned to nobody, because it can quote the source back.
 */
export function documentParseRefusalBody(err: DocumentParseRefused): Record<string, unknown> {
  return {
    error: 'document_refused',
    message: 'the document parser refused this source',
    detail: { reason: err.reason },
  };
}

export function actionRejectionBody(err: unknown):
  | {
      readonly status: number;
      readonly body: Record<string, unknown>;
    }
  | undefined {
  // The dispatcher already turns a payload refusal and a trigger-raised rule violation into an
  // ActionRejected, so every surface gets the same refusal (RQ-012). Applied again here only
  // for an error that reached the route by some other path — a deferred check at commit in a
  // route that owns its transaction — and it returns anything else unchanged: a fault stays a
  // 500 that names nothing but a correlation id.
  const refusal = asActionRefusal(err);
  if (refusal instanceof ActionRejected) {
    return {
      status: STATUS[refusal.failure] ?? 422,
      body: { error: refusal.failure, message: refusal.message, detail: refusal.detail },
    };
  }
  if (err instanceof DocumentParseRefused) {
    return { status: 422, body: documentParseRefusalBody(err) };
  }
  return undefined;
}
