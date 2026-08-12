/** Generic lifecycle-action panel. Registry remains source; pages supply only object identity. */

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { act, get, ApiError } from '../../lib/api';
import { developmentCaller } from '../../lib/caller';
import { formatState } from '@kf/ui';

interface Available {
  readonly actions: readonly {
    readonly actionType: string;
    readonly toStates: readonly string[];
    readonly requiresChoice: boolean;
    readonly reasonRequired: boolean;
  }[];
}

export async function ActionPanel({
  objectId,
  path,
  state,
  rowVersion,
}: {
  readonly objectId: string;
  readonly path: string;
  readonly state: string;
  readonly rowVersion: string;
}) {
  const caller = developmentCaller();
  let available: Available;
  try {
    available = await get<Available>(
      `/objects/${encodeURIComponent(objectId)}/available-actions`,
      caller,
    );
  } catch {
    return <p style={{ color: '#666' }}>Available actions could not be loaded.</p>;
  }
  if (available.actions.length === 0) {
    return (
      <p style={{ color: '#666' }}>No lifecycle action is available from {formatState(state)}.</p>
    );
  }

  async function perform(formData: FormData): Promise<void> {
    'use server';
    const actionType = String(formData.get('actionType'));
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
        developmentCaller(),
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
      {available.actions.map((action) => (
        <form
          key={action.actionType}
          action={perform}
          style={{
            display: 'flex',
            gap: '0.6rem',
            alignItems: 'center',
            flexWrap: 'wrap',
            border: '1px solid #e5e7eb',
            borderRadius: '0.6rem',
            padding: '0.75rem',
          }}
        >
          <input type="hidden" name="actionType" value={action.actionType} />
          <input
            type="hidden"
            name="idempotencyKey"
            value={`web-${caller.actorId}-${objectId}-${action.actionType}-v${rowVersion}`}
          />
          <strong>{formatState(action.actionType)}</strong>
          {action.requiresChoice ? (
            <select name="toState" required style={{ padding: '0.35rem' }}>
              <option value="">choose outcome…</option>
              {action.toStates.map((target) => (
                <option key={target} value={target}>
                  {formatState(target)}
                </option>
              ))}
            </select>
          ) : (
            <span style={{ color: '#64748b' }}>→ {formatState(action.toStates[0] ?? '')}</span>
          )}
          {action.reasonRequired ? (
            <input
              name="reason"
              required
              placeholder="reason"
              style={{ padding: '0.35rem', flex: '1 1 14rem' }}
            />
          ) : null}
          <button type="submit" style={{ padding: '0.4rem 0.9rem', cursor: 'pointer' }}>
            Perform
          </button>
        </form>
      ))}
    </div>
  );
}
