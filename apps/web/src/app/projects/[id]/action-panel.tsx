/**
 * The action panel.
 *
 * Every button here is a named action, and the list of them comes from the API — which reads
 * the same registry the dispatcher does. Hard-coding which buttons belong to which state
 * would be a second copy of the state machine, and the copy is the one that goes stale:
 * buttons that always fail, or a legal transition nobody can reach.
 *
 * There is no editable field on this panel and no "save". A form that PATCHed a status would
 * move a controlled record with no actor, no reason and no audit event.
 */

import { revalidatePath } from 'next/cache';
import { act, get, ApiError } from '../../../lib/api';
import { developmentCaller } from '../../../lib/caller';
import { formatState } from '@kf/ui';

interface Available {
  readonly actions: readonly {
    readonly actionType: string;
    readonly toStates: readonly string[];
    readonly requiresChoice: boolean;
  }[];
}

/** Actions the dispatcher requires a reason for. A silent correction is not a correction. */
const REASON_REQUIRED = new Set(['correct_record', 'reject_decision', 'amend_work_order']);

export async function ActionPanel({ projectId, state }: { projectId: string; state: string }) {
  const caller = developmentCaller();

  let available: Available;
  try {
    available = await get<Available>(`/objects/${projectId}/available-actions`, caller);
  } catch {
    return <p style={{ color: '#666' }}>Available actions could not be loaded.</p>;
  }

  if (available.actions.length === 0) {
    return (
      <p style={{ color: '#666' }}>
        Nothing can move this record from <code>{formatState(state)}</code>. That is either a
        terminal state or one only another kind of record can advance.
      </p>
    );
  }

  async function perform(formData: FormData): Promise<void> {
    'use server';
    const actionType = String(formData.get('actionType'));
    const toState = formData.get('toState');
    const reason = formData.get('reason');
    // Supplied here, once per rendered form, so a double-submit is one logical attempt and
    // replays rather than applying twice.
    const idempotencyKey = String(formData.get('idempotencyKey'));

    try {
      await act(
        actionType,
        {
          targetIds: [projectId],
          ...(typeof toState === 'string' && toState !== ''
            ? { payload: { to_state: toState } }
            : {}),
          ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
          idempotencyKey,
        },
        developmentCaller(),
      );
    } catch (err: unknown) {
      // Refusals are expected outcomes and reach the page as such; a fault is rethrown so
      // the error boundary handles it rather than the page pretending it worked.
      if (err instanceof ApiError && err.isRefusal) {
        revalidatePath(`/projects/${projectId}`);
        return;
      }
      throw err;
    }
    revalidatePath(`/projects/${projectId}`);
  }

  return (
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      {available.actions.map((a) => (
        <form
          key={a.actionType}
          action={perform}
          style={{
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'center',
            flexWrap: 'wrap',
            border: '1px solid #eee',
            borderRadius: '0.375rem',
            padding: '0.6rem 0.75rem',
          }}
        >
          <input type="hidden" name="actionType" value={a.actionType} />
          <input
            type="hidden"
            name="idempotencyKey"
            // Bound to the action and the record's CURRENT version of history, so a retry of
            // the same rendered form replays, and a genuinely new attempt after the record
            // moved gets a new key.
            value={`web-${projectId}-${a.actionType}-${state}`}
          />
          <strong style={{ fontWeight: 600 }}>{formatState(a.actionType)}</strong>

          {a.requiresChoice ? (
            <select name="toState" required style={{ padding: '0.25rem' }}>
              <option value="">choose an outcome…</option>
              {a.toStates.map((s) => (
                <option key={s} value={s}>
                  {formatState(s)}
                </option>
              ))}
            </select>
          ) : (
            <span style={{ color: '#666', fontSize: '0.85rem' }}>
              → {formatState(a.toStates[0] ?? '')}
            </span>
          )}

          {REASON_REQUIRED.has(a.actionType) ? (
            <input
              type="text"
              name="reason"
              required
              placeholder="reason (required)"
              style={{ padding: '0.25rem', flex: '1 1 16rem' }}
            />
          ) : null}

          <button type="submit" style={{ padding: '0.3rem 0.75rem' }}>
            Perform
          </button>
        </form>
      ))}
      <p style={{ color: '#666', fontSize: '0.85rem', margin: 0 }}>
        These are the transitions the ontology permits from this state. Any of them may still be
        refused — separation of duty, a precondition, or a financial ceiling — because those depend
        on facts this list does not evaluate.
      </p>
    </div>
  );
}
