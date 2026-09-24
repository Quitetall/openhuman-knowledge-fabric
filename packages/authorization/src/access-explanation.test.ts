import { createHash } from 'node:crypto';
import { canonicalize } from '@kf/canonicalization';
import { describe, expect, it } from 'vitest';
import { ACCESS_EXPLANATION_FORMAT, accessExplanationDigest } from './access-grants.js';

const body = {
  format: ACCESS_EXPLANATION_FORMAT,
  capability: 'read' as const,
  personId: '00000000-0000-7000-8000-000000000001',
  organizationId: '00000000-0000-7000-8000-000000000002',
  objectId: '00000000-0000-7000-8000-000000000003',
  decision: 'denied' as const,
  deniedBy: 'grant_coverage' as const,
  steps: [
    {
      step: 'grant_coverage' as const,
      outcome: 'fail' as const,
      detail: { grants: [], zeta: 1, alpha: null },
    },
  ],
};

describe('access explanation digest', () => {
  it('is tagged kf-access-explanation-v2', () => {
    expect(ACCESS_EXPLANATION_FORMAT).toBe('kf-access-explanation-v2');
  });

  it('is SHA-256 over the RFC 8785 form, tag included', () => {
    expect(accessExplanationDigest(body)).toBe(
      createHash('sha256').update(canonicalize(body), 'utf8').digest('hex'),
    );
    expect(canonicalize(body)).toContain('"format":"kf-access-explanation-v2"');
  });

  it('does not depend on the order the explanation was built in', () => {
    const reordered = {
      steps: body.steps.map(({ detail, outcome, step }) => ({
        detail: { alpha: detail.alpha, zeta: detail.zeta, grants: detail.grants },
        outcome,
        step,
      })),
      deniedBy: body.deniedBy,
      decision: body.decision,
      objectId: body.objectId,
      organizationId: body.organizationId,
      personId: body.personId,
      capability: body.capability,
      format: body.format,
    };
    expect(accessExplanationDigest(reordered)).toBe(accessExplanationDigest(body));
    // What v1 did: the same facts, two digests.
    expect(createHash('sha256').update(JSON.stringify(reordered)).digest('hex')).not.toBe(
      createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    );
  });
});
