/** Generic lifecycle-action panel. Registry remains source; pages supply only object identity. */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  act,
  get,
  ApiError,
  parseAvailableActionsView,
  type AvailableActionsView,
} from '../../lib/api';
import { webCaller } from '../../lib/session';
import { formatState } from '@kf/ui';
import { PendingButton } from './pending-button';

export async function ActionPanel({
  objectId,
  path,
  state,
  rowVersion,
  blockedActionTypes = [],
}: {
  readonly objectId: string;
  readonly path: string;
  readonly state: string;
  readonly rowVersion: string;
  readonly blockedActionTypes?: readonly string[];
}) {
  const caller = await webCaller(path);
  let available: AvailableActionsView;
  try {
    available = await get(
      `/objects/${encodeURIComponent(objectId)}/available-actions`,
      caller,
      parseAvailableActionsView,
    );
  } catch {
    return (
      <p role="status" aria-live="polite" className="kf-status kf-status-warning">
        Available actions could not be loaded.
      </p>
    );
  }
  if (available.actions.length === 0) {
    return (
      <p style={{ color: '#666' }}>No lifecycle action is available from {formatState(state)}.</p>
    );
  }

  async function perform(formData: FormData): Promise<void> {
    'use server';
    const actionType = String(formData.get('actionType'));
    if (blockedActionTypes.includes(actionType)) {
      redirect(
        `${path}?refused=${encodeURIComponent('Human authority action is blocked in this workbench.')}`,
      );
    }
    const toState = formData.get('toState');
    const reason = formData.get('reason');
    try {
      await act(
        actionType,
        {
          targetIds: [objectId],
          ...(typeof toState === 'string' && toState !== ''
            ? { payload: { to_state: toState } }
            : {}),
          ...(typeof reason === 'string' && reason !== '' ? { reason } : {}),
          idempotencyKey: String(formData.get('idempotencyKey')),
          expectedVersion: Number(rowVersion),
        },
        await webCaller(path),
      );
    } catch (error: unknown) {
      if (error instanceof ApiError && error.isRefusal) {
        revalidatePath(path);
        redirect(`${path}?refused=${encodeURIComponent(error.message)}`);
      }
      throw error;
    }
    revalidatePath(path);
  }

  return (
    <div style={{ display: 'grid', gap: '0.75rem' }}>
      {available.actions.map((action) => {
        const blocked = blockedActionTypes.includes(action.actionType);
        const actionLabel = formatState(action.actionType);
        const explanationId = `blocked-${action.actionType.replaceAll(/[^A-Za-z0-9_-]/g, '-')}`;
        return (
          <form
            key={action.actionType}
            action={perform}
            style={{
              border: '1px solid #e5e7eb',
              borderRadius: '0.6rem',
              padding: '0.75rem',
            }}
          >
            <fieldset
              disabled={blocked}
              aria-describedby={blocked ? explanationId : undefined}
              style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
            >
              <legend style={{ padding: 0 }}>
                <strong>{actionLabel}</strong>
              </legend>
              <div
                className="kf-action-controls"
                style={{
                  display: 'flex',
                  gap: '0.6rem',
                  alignItems: 'center',
                  marginTop: '0.5rem',
                }}
              >
                <input type="hidden" name="actionType" value={action.actionType} />
                <input
                  type="hidden"
                  name="idempotencyKey"
                  value={`web-${caller.actorId}-${objectId}-${action.actionType}-v${rowVersion}`}
                />
                {action.requiresChoice ? (
                  <select
                    name="toState"
                    required
                    aria-label={`Outcome for ${actionLabel}`}
                    className="kf-control"
                    style={{ flex: '0 1 14rem' }}
                  >
                    <option value="">choose outcome…</option>
                    {action.toStates.map((target) => (
                      <option key={target} value={target}>
                        {formatState(target)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span style={{ color: '#64748b' }}>
                    → {formatState(action.toStates[0] ?? '')}
                  </span>
                )}
                {action.reasonRequired ? (
                  <input
                    name="reason"
                    required
                    aria-label={`Reason for ${actionLabel}`}
                    placeholder="reason"
                    className="kf-control"
                    style={{ flex: '1 1 14rem' }}
                  />
                ) : null}
                <PendingButton pendingLabel={`Performing ${actionLabel}…`} disabled={blocked}>
                  {blocked ? 'Human authority required' : 'Perform'}
                </PendingButton>
              </div>
            </fieldset>
            {blocked ? (
              <p id={explanationId} style={{ color: '#92400e', margin: '0.65rem 0 0' }}>
                Unavailable here: this action requires a human authority workflow that the workbench
                cannot perform.
              </p>
            ) : null}
          </form>
        );
      })}
    </div>
  );
}
