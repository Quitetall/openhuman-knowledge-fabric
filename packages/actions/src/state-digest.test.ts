import { digest } from '@kf/canonicalization';
import { describe, expect, it } from 'vitest';
import { ACTION_STATE_FORMAT, actionStateDigest, semanticActionRequestDigest } from './index.js';

// Goldens recomputed independently in Python (json.dumps sort_keys, compact separators,
// ensure_ascii=False, sha256) — not by calling the code under test.
const STATE = [
  { id: '00000000-0000-4000-8000-000000000001', state: 'draft' },
  { id: '00000000-0000-4000-8000-000000000002', state: 'approved' },
];

describe('the state an act commits to its audit link (KF-SAS-RQ-016)', () => {
  it('is taken under kf-action-state-v1, the tag inside the preimage', () => {
    expect(ACTION_STATE_FORMAT).toBe('kf-action-state-v1');
    expect(actionStateDigest(STATE)).toBe(
      '23504dbcb85781082ed964a3487709051d92b30bc6ddb7fb5725e060da00e2c5',
    );
  });

  it('is not the untagged digest of the bare list that links before the tag recorded', () => {
    const untagged = '39b4ff8e0811cc8fcec435b9b2ca6eab6919084151265f0ffd1c92cce80216e2';
    expect(digest(STATE)).toBe(untagged);
    expect(actionStateDigest(STATE)).not.toBe(untagged);
  });

  it('commits to exactly id and state, whatever else the row carries', () => {
    const wider = STATE.map((row) => ({ ...row, title: 'ignored' }));
    expect(actionStateDigest(wider)).toBe(actionStateDigest(STATE));
  });
});

describe('the semantic request digest keeps its recorded value', () => {
  // core.action.request_digest is stored and re-derived on every idempotent retry, so moving it
  // onto taggedDigest must not move a single byte.
  it('matches the kf-action-request-v1 golden', () => {
    expect(
      semanticActionRequestDigest({
        organizationId: '00000000-0000-4000-8000-000000000010',
        actionType: 'approve_document',
        actorId: '00000000-0000-4000-8000-000000000011',
        actingRoleId: '00000000-0000-4000-8000-000000000012',
        targetIds: ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001'],
        payload: {},
        reason: 'ready',
        effectiveAt: new Date('2026-09-24T00:00:00.000Z'),
        idempotencyKey: 'not-semantic',
        maxClassification: 'internal',
      }),
    ).toBe('31cc94cb04dadba27e0045837b0132c3c398b9d668d1cc260e9a2820e1dcbf6f');
  });
});
