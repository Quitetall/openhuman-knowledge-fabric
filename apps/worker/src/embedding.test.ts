/**
 * The embedding pump's own schedule (SAS §100.44): a pass that empties the queue is followed by
 * the idle wait; a pass the engine failed by a doubling backoff, capped, and reset by the next
 * healthy pass. No database and no engine: the pass and the clock are injected.
 */

import { describe, expect, it } from 'vitest';
import type { Pool } from '@kf/database';
import type { RetrievalClient } from '@kf/retrieval';
import { failureOf, startEmbeddingPump, type EmbeddingDrainResult } from './embedding.js';
import { embeddingConcurrency } from './config.js';

const result = (stoppedBy: EmbeddingDrainResult['stoppedBy']): EmbeddingDrainResult => ({
  claimed: 0,
  embedded: 0,
  stoppedBy,
  failed: [],
});

async function waitsFor(
  passes: readonly (EmbeddingDrainResult['stoppedBy'] | 'throws')[],
): Promise<number[]> {
  const waits: number[] = [];
  let pass = 0;
  let finish: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const pump = startEmbeddingPump({} as Pool, {} as RetrievalClient, {
    idleMs: 2_000,
    backoffMs: 2_000,
    maxBackoffMs: 30_000,
    drain: () => {
      const next = passes[pass++];
      if (next === undefined) {
        finish();
        return new Promise(() => undefined);
      }
      if (next === 'throws') return Promise.reject(new Error('database unreachable'));
      return Promise.resolve(result(next));
    },
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  });
  await done;
  void pump.stop();
  return waits;
}

describe('the embedding pump schedule', () => {
  it('backs off, doubling to its cap, while the engine fails, and resets on a healthy pass', async () => {
    expect(
      await waitsFor([
        'empty',
        'engine_unavailable',
        'failing',
        'failing',
        'throws',
        'engine_unavailable',
        'failing',
        'empty',
        'failing',
      ]),
    ).toEqual([2_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 2_000, 2_000]);
  });

  it('classifies an engine refusal apart from an engine it could not use', () => {
    expect(failureOf('engine refused: embedder_unavailable — no')).toBe('engine_refused');
    expect(failureOf('engine did not answer within 60000ms')).toBe('engine_unavailable');
    expect(failureOf('socket failed: ECONNREFUSED')).toBe('engine_unavailable');
  });

  it('takes KF_EMBEDDING_CONCURRENCY from 1 to 16, and refuses anything else', () => {
    expect(embeddingConcurrency({})).toBe(1);
    expect(embeddingConcurrency({ KF_EMBEDDING_CONCURRENCY: '8' })).toBe(8);
    for (const value of ['0', '17', '2.5', 'eight', '-1']) {
      expect(() => embeddingConcurrency({ KF_EMBEDDING_CONCURRENCY: value })).toThrow(
        /KF_EMBEDDING_CONCURRENCY/,
      );
    }
  });
});
