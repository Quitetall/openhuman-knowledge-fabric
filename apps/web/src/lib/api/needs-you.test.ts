import { describe, expect, it } from 'vitest';
import { parseNeedsYou } from './needs-you';
import { UNVERIFIED_LABEL } from './verification';

const record = (over: Record<string, unknown> = {}) => ({
  id: '01a114e0-339e-7463-afe2-e09d9261e893',
  objectType: 'observation',
  title: 'Bench 4 reading',
  classification: 'internal',
  lifecycleState: 'captured',
  rowVersion: 1,
  agentClientId: 'bench-agent',
  writtenFor: '01a114e0-339e-7463-afe2-e09d9261e894',
  writtenAt: '2026-10-07T06:00:00.000Z',
  verification: { verified: false, label: UNVERIFIED_LABEL },
  ...over,
});

const answer = (items: unknown[]) => ({
  toVerify: { items, total: items.length },
  awaitingOthers: { items: [], total: 0 },
  proposals: { items: [], total: 0 },
});

describe('parseNeedsYou', () => {
  it('reads the three lists', () => {
    const parsed = parseNeedsYou(answer([record()]));
    expect(parsed.toVerify.items[0]).toMatchObject({ id: record().id, rowVersion: 1 });
    expect(parsed.toVerify.items[0]!.verification.verified).toBe(false);
  });

  it('fails closed: an item claiming verified without the facts is shown unverified', () => {
    const parsed = parseNeedsYou(
      answer([record({ verification: { verified: true, label: 'verified by trust me' } })]),
    );
    expect(parsed.toVerify.items[0]!.verification).toEqual({
      verified: false,
      label: UNVERIFIED_LABEL,
    });
  });

  it('keeps a policy verification, which names its policy', () => {
    const label =
      'verified by policy 01a114e0-339e-7463-afe2-e09d9261e895 set by p, at 2026-10-07T06:00:00.000Z';
    const parsed = parseNeedsYou(
      answer([
        record({
          verification: {
            verified: true,
            basis: 'verified_by_policy',
            verifiedAt: '2026-10-07T06:00:00.000Z',
            verifiedBy: 'p',
            label,
          },
        }),
      ]),
    );
    expect(parsed.toVerify.items[0]!.verification).toMatchObject({ verified: true, label });
  });

  it('refuses an answer missing a list or an item’s version', () => {
    expect(() => parseNeedsYou({ toVerify: { items: [], total: 0 } })).toThrow();
    expect(() => parseNeedsYou(answer([record({ rowVersion: '1' })]))).toThrow();
  });
});
