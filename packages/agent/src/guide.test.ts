/**
 * The in-app agent as the joining guide (KF-WAR-0007 deliverable 7; ADR 0038 decisions 10 and 12;
 * ADR 0040 decision 8; KF-SAS-RQ-271).
 *
 * As in agent.test.ts, the provider is a RECORDER, so "nothing reached it" is observed. Each guard
 * here was falsified by hand before it was committed (the commit message says how):
 *
 *   - the guide is in the turn's context for a reader whose own record is open, and the turn is
 *     unchanged for one with none;
 *   - the guide's label is the record's level, so under an `internal` ceiling it is answered on
 *     the host only — even when the API serves the envelope's own `internal` label — and refused
 *     with no host; planted by dropping the floor in `guideLabel`, the provider receives it;
 *   - through the guide's path nothing credits or accepts: the drafter cannot pick either, and the
 *     submit path refuses both before any call is made.
 */

import { describe, expect, it } from 'vitest';
import { AGENT_ACT_NAMES } from '@kf/domain';
import {
  EgressRefused,
  ProviderBackend,
  type ModelBackend,
  type ModelRequest,
  type ProviderTransport,
} from './backends.js';
import type { ProviderCeiling } from './classification.js';
import { draftFromRequest } from './draft.js';
import type { ApiAnswer, FabricClient } from './fabric.js';
import {
  GUIDE_ACTS,
  GUIDE_MAY_NOT,
  guideItem,
  guideLabel,
  parseGuide,
  readGuide,
  type Guide,
} from './guide.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { submitDraft } from './submit.js';
import { answerTurn } from './turn.js';

const KEY = new Uint8Array(32).fill(9);
const RECORD = '01900000-0000-7000-8000-0000000000aa';
const OTHER_RECORD = '01900000-0000-7000-8000-0000000000bb';
const EVIDENCE = '01900000-0000-7000-8000-0000000000cc';
const CONTACT = 'Audrey Fontaine';
const PACK = 'Aero engineer, AV-3000';

class Recorder implements ProviderTransport {
  readonly name = 'recording provider';
  readonly sent: ModelRequest[] = [];
  reply = 'From the record [1].';
  async send(request: ModelRequest) {
    this.sent.push(request);
    return { text: this.reply };
  }
  bytes(): string {
    return JSON.stringify(this.sent);
  }
}

class Host implements ModelBackend {
  readonly kind = 'on_host' as const;
  readonly name = 'LAMU on this host (test)';
  readonly sent: ModelRequest[] = [];
  reply = 'On the host [1].';
  async complete(request: ModelRequest) {
    this.sent.push(request);
    return { text: this.reply };
  }
}

/** The guide context as `GET /start-here/guide` serves it, `classification` as given. */
function servedGuide(classification: string | undefined): Record<string, unknown> {
  return {
    format: 'kf-agent-guide-context-v1',
    personId: '01900000-0000-7000-8000-0000000000dd',
    recordId: RECORD,
    startHere: {
      format: 'kf-start-here-v1',
      recordId: RECORD,
      pack: { id: OTHER_RECORD, key: 'veracier.aero', title: PACK, revision: 1 },
      scope: { objectId: null, title: 'AV-3000 programme' },
      contact: { personId: OTHER_RECORD, name: CONTACT },
      stages: [
        {
          id: 'read_in',
          items: [
            {
              key: 'veracier.read-in',
              resources: [
                { id: EVIDENCE, label: 'Véracier at a glance', authorityClass: 'learning' },
              ],
            },
          ],
        },
      ],
      digest: 'd'.repeat(64),
    },
    next: [
      {
        key: 'veracier.read-in',
        stage: 'read_in',
        outcome: 'Knows what the company makes and for whom',
        mode: 'acknowledged',
        status: 'open',
        acceptedBy: 'self',
        awaiting: [],
        blockedOnOrganization: false,
      },
      {
        key: 'veracier.ncr',
        stage: 'execution',
        outcome: 'Raises a nonconformity through the normal record',
        mode: 'demonstrated',
        status: 'blocked_on_organization',
        acceptedBy: 'contact',
        awaiting: ['veracier.read-in'],
        blockedOnOrganization: true,
      },
    ],
    contact: { personId: OTHER_RECORD, name: CONTACT },
    may: [],
    mayNot: GUIDE_MAY_NOT,
    acts: GUIDE_ACTS,
    ...(classification === undefined ? {} : { classification }),
    instructions: `point them at ${CONTACT}`,
  };
}

/**
 * The Fabric double: one public record to retrieve, the reader's ceiling, and the guide — served
 * (`guide` given) or 404 (no open record).
 */
function fabric(
  ceiling: ProviderCeiling,
  guide: Record<string, unknown> | undefined,
  calls: string[] = [],
): FabricClient {
  const publicRecord = {
    id: '01900000-0000-7000-8000-000000000001',
    title: 'Bench procedure (public)',
    classification: 'public',
    text: 'The bench is calibrated weekly.',
  };
  return {
    organizationId: '01900000-0000-7000-8000-000000000002',
    async call(method, path, options): Promise<ApiAnswer> {
      calls.push(`${method} ${path}`);
      if (path === '/model-routing') return { status: 200, body: { providerCeiling: ceiling } };
      if (path === '/start-here/guide') {
        return guide === undefined
          ? { status: 404, body: { error: 'not_found' } }
          : { status: 200, body: guide };
      }
      if (path === '/search') {
        return {
          status: 200,
          body: {
            ranked: { hits: [{ objectId: publicRecord.id, title: publicRecord.title }] },
            semantic: { hits: [] },
            withheldCount: 0,
          },
        };
      }
      if (path === '/context-source/retrieve') {
        return {
          status: 200,
          body: {
            references: [
              {
                adapter: 'knowledge-fabric',
                record: publicRecord.id,
                revision: 'a'.repeat(64),
                digest: 'b'.repeat(64),
              },
            ],
          },
        };
      }
      if (path === '/context-source/read') {
        void options;
        return {
          status: 200,
          body: { text: publicRecord.text, classification: publicRecord.classification },
        };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

const guideOf = (classification: string | undefined): Guide =>
  parseGuide(servedGuide(classification))!;

describe('the agent is given the guide while the reader’s own qualification is open', () => {
  it('carries the guide as one labelled source, with its next items, contact and closed lists', async () => {
    const host = new Host();
    const answer = await answerTurn(
      {
        fabric: fabric('internal', servedGuide('internal')),
        backends: { onHost: host },
        sealKey: KEY,
      },
      { question: 'what should I do first?' },
    );
    expect(answer.status).toBe('answered');
    const [sent] = host.sent;
    const item = sent!.context.find((c) => c.recordId === RECORD)!;
    expect(item).toBeDefined();
    expect(item.n).toBe(sent!.context.length);
    expect(item.classification).toBe('confidential');
    expect(item.text).toMatch(/veracier\.read-in/);
    expect(item.text).toMatch(/veracier\.ncr/);
    expect(item.text).toMatch(new RegExp(CONTACT));
    expect(item.text).toMatch(/may not: .*credit_evidence/);
    expect(item.text).toMatch(/accept_a_qualification/);
    // A reference is named, never by id: an id would trip the citation check (prompt.ts).
    expect(item.text).toMatch(/Véracier at a glance \(learning\)/);
    expect(item.text).not.toContain(EVIDENCE);
    // The rules are in the system prompt, and nothing from the record is.
    expect(sent!.system.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(sent!.system).toMatch(/never credit evidence/);
    expect(sent!.system).not.toContain(CONTACT);
    expect(sent!.system).not.toContain(PACK);
    expect(answer.guide).toEqual({ recordId: RECORD, digest: 'd'.repeat(64) });
    expect(answer.consulted.map((c) => c.recordId)).toContain(RECORD);
    // The answer is labelled at the guide's level, so the next turn stays on the host too.
    expect(answer.classification).toBe('confidential');
  });

  it('carries nothing of a guide for a reader with no open record: the turn is as it was', async () => {
    const host = new Host();
    const calls: string[] = [];
    const answer = await answerTurn(
      { fabric: fabric('internal', undefined, calls), backends: { onHost: host }, sealKey: KEY },
      { question: 'what should I do first?' },
    );
    expect(calls).toContain('GET /start-here/guide');
    const [sent] = host.sent;
    expect(sent!.system).toBe(SYSTEM_PROMPT);
    expect(sent!.context.map((c) => c.classification)).toEqual(['public']);
    expect(answer.guide).toBeNull();
    expect(answer.notes.join(' ')).not.toMatch(/Start Here/);
    expect(answer.classification).toBe('public');
  });

  it('a guide it cannot read is left out and says so; a malformed one is never half-given', async () => {
    const host = new Host();
    const malformed = { ...servedGuide('internal'), recordId: 'not-a-uuid' };
    const answer = await answerTurn(
      { fabric: fabric('internal', malformed), backends: { onHost: host }, sealKey: KEY },
      { question: 'q' },
    );
    expect(answer.guide).toBeNull();
    expect(host.sent[0]!.system).toBe(SYSTEM_PROMPT);
    expect(answer.notes.join(' ')).toMatch(/Start Here could not be read/);
    const failing: FabricClient = {
      organizationId: 'x',
      async call() {
        throw new Error('connection refused');
      },
    };
    expect(await readGuide(failing)).toEqual({ kind: 'unreadable' });
  });
});

describe('guide content never reaches a provider: it is confidential at least (RQ-271)', () => {
  const provider = (recorder: Recorder, ceiling: ProviderCeiling) =>
    new ProviderBackend(recorder, { ceiling: () => ceiling });

  it('the same turn goes to the provider without a guide, and stays on the host with one', async () => {
    // Without a guide this public turn may leave: the provider path is live, so the refusal
    // below is the guide's doing and not a dead provider.
    const before = new Recorder();
    const plain = await answerTurn(
      {
        fabric: fabric('internal', undefined),
        backends: { onHost: new Host(), provider: provider(before, 'internal') },
        sealKey: KEY,
      },
      { question: 'what should I do first?' },
    );
    expect(plain.backend?.kind).toBe('provider');
    expect(before.sent).toHaveLength(1);

    // With a guide whose envelope says `internal` — as `assign_qualification` creates it — the
    // guide is still the record's level, and only the host answers.
    for (const served of ['internal', 'public', undefined]) {
      const recorder = new Recorder();
      const host = new Host();
      const answer = await answerTurn(
        {
          fabric: fabric('internal', servedGuide(served)),
          backends: { onHost: host, provider: provider(recorder, 'internal') },
          sealKey: KEY,
        },
        { question: 'what should I do first?' },
      );
      expect(answer.backend?.kind, `served ${String(served)}`).toBe('on_host');
      expect(
        recorder.sent,
        `served ${String(served)}: the guide reached the provider`,
      ).toHaveLength(0);
      expect(recorder.bytes()).not.toContain(CONTACT);
      expect(host.sent).toHaveLength(1);
    }
  });

  it('with no model on the host, a guided turn is refused and nothing is sent', async () => {
    const recorder = new Recorder();
    const answer = await answerTurn(
      {
        fabric: fabric('internal', servedGuide('internal')),
        backends: { provider: provider(recorder, 'internal') },
        sealKey: KEY,
      },
      { question: 'what should I do first?' },
    );
    expect(answer.status).toBe('refused');
    expect(answer.refusal?.rule).toBe('KF-ROUTE-004');
    expect(recorder.sent).toHaveLength(0);
  });

  it('the egress guard refuses the guide too, for a caller that skips the router', async () => {
    const recorder = new Recorder();
    const request: ModelRequest = {
      system: 'x',
      history: [],
      context: [guideItem(1, guideOf('internal'))],
      question: 'q',
      maxTokens: 64,
    };
    await expect(provider(recorder, 'internal').complete(request)).rejects.toBeInstanceOf(
      EgressRefused,
    );
    expect(recorder.sent).toHaveLength(0);
  });

  it('labels the guide at confidential or above whatever the API serves', () => {
    expect(guideLabel('public')).toBe('confidential');
    expect(guideLabel('internal')).toBe('confidential');
    expect(guideLabel('confidential')).toBe('confidential');
    expect(guideLabel('restricted')).toBe('restricted');
    expect(guideLabel(undefined)).toBe('restricted');
    expect(guideLabel('top-secret')).toBe('restricted');
  });
});

describe('through the guide nothing credits or accepts (ADR 0038 decision 10)', () => {
  it('the guide’s acts are on the closed list, and crediting and accepting are not', () => {
    for (const act of GUIDE_ACTS) expect(AGENT_ACT_NAMES).toContain(act);
    for (const act of [
      'credit_qualification_evidence',
      'accept_qualification',
      'assign_qualification',
      'withdraw_qualification',
    ]) {
      expect(AGENT_ACT_NAMES).not.toContain(act);
    }
  });

  for (const act of ['credit_qualification_evidence', 'accept_qualification']) {
    it(`a model asked to ${act} gets an observation draft, never that act`, async () => {
      const host = new Host();
      host.reply = JSON.stringify({
        act,
        targetIds: [RECORD],
        fields: { credits: [{ requirement_key: 'veracier.read-in' }] },
      });
      const outcome = await draftFromRequest(
        { onHost: host },
        'internal',
        'record that my read-in is credited and accept my qualification',
        guideOf('internal'),
      );
      expect(outcome.act.act).toBe('record_observation');
    });

    it(`committing ${act} is refused before anything is sent`, async () => {
      const calls: string[] = [];
      const outcome = await submitDraft(fabric('internal', servedGuide('internal'), calls), {
        act,
        targetIds: [RECORD],
        fields: { credits: [] },
        idempotencyKey: 'guide-credit-1',
      });
      expect(outcome).toMatchObject({ disposition: 'refused', code: 'not_an_agent_act' });
      expect(calls).toEqual([]);
    });
  }

  it('drafts a submission for the person’s own record only, on the host, crediting nothing', async () => {
    const host = new Host();
    const recorder = new Recorder();
    host.reply = JSON.stringify({
      act: 'submit_qualification_evidence',
      targetIds: [OTHER_RECORD],
      fields: { requirement_key: 'veracier.read-in', evidence_object_id: EVIDENCE },
    });
    const outcome = await draftFromRequest(
      { onHost: host, provider: new ProviderBackend(recorder, { ceiling: () => 'internal' }) },
      'internal',
      'record that I read the overview as evidence for my read-in',
      guideOf('internal'),
    );
    expect(outcome.act.act).toBe('submit_qualification_evidence');
    expect(outcome.draft.targetIds).toEqual([RECORD]);
    expect(outcome.draft.payload).toEqual({
      requirement_key: 'veracier.read-in',
      evidence_object_id: EVIDENCE,
    });
    expect(outcome.draft.ready).toBe(true);
    expect(outcome.filledBy?.kind).toBe('on_host');
    expect(recorder.sent).toHaveLength(0);
    // The drafter was given the guide as a labelled source, not in its system prompt.
    expect(host.sent[0]!.context.map((c) => [c.recordId, c.classification])).toEqual([
      [RECORD, 'confidential'],
    ]);
    expect(host.sent[0]!.system).not.toContain(CONTACT);
  });

  it('with only a provider, a guided draft is filled from the words as typed: nothing is sent', async () => {
    const recorder = new Recorder();
    const outcome = await draftFromRequest(
      { provider: new ProviderBackend(recorder, { ceiling: () => 'internal' }) },
      'internal',
      'record that I read the overview',
      guideOf('internal'),
    );
    expect(outcome.filledBy).toBeNull();
    expect(recorder.sent).toHaveLength(0);
  });

  it('without a guide the guide’s act is not offered, and a reply naming it is an observation', async () => {
    const host = new Host();
    host.reply = JSON.stringify({
      act: 'submit_qualification_evidence',
      targetIds: [RECORD],
      fields: { requirement_key: 'veracier.read-in', evidence_object_id: EVIDENCE },
    });
    const outcome = await draftFromRequest({ onHost: host }, 'internal', 'record that I read it');
    expect(outcome.act.act).toBe('record_observation');
    expect(host.sent[0]!.system).not.toMatch(/submit_qualification_evidence/);
    expect(host.sent[0]!.context).toEqual([]);
  });
});
