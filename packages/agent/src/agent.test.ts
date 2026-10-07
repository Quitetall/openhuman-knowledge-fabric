/**
 * The in-app agent's guards, without a network (KF-WAR-0006 OBL-001 to OBL-003).
 *
 * The provider is a RECORDER: it keeps every request it is handed, so each assertion is about what
 * was sent, not about what the router claims it chose. Each guard is falsified below by the change
 * OBL-001 names — the comparison lowered by one rank — and the recorder then holds the record, so
 * the assertion that it does not is an assertion about the guard.
 */

import { describe, expect, it } from 'vitest';
import { AGENT_ACTS, draftAgentAct } from '@kf/domain';
import {
  EgressRefused,
  ProviderBackend,
  type ModelBackend,
  type ModelRequest,
  type ProviderTransport,
} from './backends.js';
import { mayLeaveHost, rankOf, type MayLeaveHost, type ProviderCeiling } from './classification.js';
import { asksToRecord, draftFromRequest, strippedRequest } from './draft.js';
import type { ApiAnswer, FabricClient } from './fabric.js';
import { LamuBackend, onHostUrl } from './lamu.js';
import { checkCitations } from './prompt.js';
import { chooseBackend } from './router.js';
import { sealTurn, verifiedClassification } from './seal.js';
import { answerTurn } from './turn.js';

const KEY = new Uint8Array(32).fill(7);

/** A provider that records every byte it is handed, and answers citing [1]. */
class Recorder implements ProviderTransport {
  readonly name = 'recording provider';
  readonly sent: ModelRequest[] = [];
  reply = 'From the record [1].';
  async send(request: ModelRequest) {
    this.sent.push(request);
    return { text: this.reply };
  }
  /** Everything it received, as one string. */
  bytes(): string {
    return JSON.stringify(this.sent);
  }
}

/** An on-host model that answers citing [1], and records too. */
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

const RESTRICTED_TEXT = 'The acquisition target is Halberd Aero; price ceiling 41 M.';

interface Corpus {
  readonly id: string;
  readonly title: string;
  readonly classification: string;
  readonly text: string;
}

/** A Fabric API double: search, retrieve and read over a fixed corpus. */
function fabricOver(
  corpus: readonly Corpus[],
  ceiling: ProviderCeiling,
  withheld = 2,
): FabricClient {
  return {
    organizationId: '01900000-0000-7000-8000-000000000002',
    async call(method, path, options): Promise<ApiAnswer> {
      if (path === '/model-routing') return { status: 200, body: { providerCeiling: ceiling } };
      if (path === '/search') {
        return {
          status: 200,
          body: {
            ranked: {
              hits: corpus.map((c) => ({
                objectId: c.id,
                title: c.title,
                classification: c.classification,
              })),
            },
            semantic: { hits: [] },
            withheldCount: withheld,
          },
        };
      }
      if (path === '/context-source/retrieve') {
        return {
          status: 200,
          body: {
            references: corpus.map((c) => ({
              adapter: 'knowledge-fabric',
              record: c.id,
              revision: 'a'.repeat(64),
              digest: 'b'.repeat(64),
            })),
          },
        };
      }
      if (path === '/context-source/read') {
        const id = (options?.body as { record: string }).record;
        const c = corpus.find((entry) => entry.id === id)!;
        return { status: 200, body: { text: c.text, classification: c.classification } };
      }
      // The reader holds no open qualification record (guide.test.ts covers one who does).
      if (path === '/start-here/guide') return { status: 404, body: { error: 'not_found' } };
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

const record = (n: number, classification: string, text = `Record ${String(n)} text`): Corpus => ({
  id: `0190000${String(n)}-0000-7000-8000-00000000000${String(n)}`,
  title: `Record ${String(n)} (${classification})`,
  classification,
  text,
});

const lowered: MayLeaveHost = (classification, ceiling) =>
  ceiling !== 'none' && rankOf(classification) <= rankOf(ceiling) + 1;

describe('restricted content never reaches a provider (OBL-001)', () => {
  for (const classification of ['public', 'internal', 'confidential', 'restricted']) {
    it(`a ${classification} record is routed ${['public', 'internal'].includes(classification) ? 'to the provider' : 'to the host only'}`, async () => {
      const recorder = new Recorder();
      const host = new Host();
      const ceiling: ProviderCeiling = 'internal';
      const corpus = [record(1, 'public'), record(2, classification, RESTRICTED_TEXT)];
      const answer = await answerTurn(
        {
          fabric: fabricOver(corpus, ceiling),
          backends: {
            onHost: host,
            provider: new ProviderBackend(recorder, { ceiling: () => ceiling }),
          },
          sealKey: KEY,
        },
        { question: 'what is the target?' },
      );
      const leaves = mayLeaveHost(classification, ceiling);
      expect(answer.backend?.kind).toBe(leaves ? 'provider' : 'on_host');
      if (!leaves) {
        expect(recorder.sent, `${corpus[1]!.id} reached the provider`).toHaveLength(0);
        expect(answer.backend?.name).toMatch(/LAMU/);
      }
    });
  }

  it('with no on-host model, a restricted context is refused, never sent to the provider', async () => {
    const recorder = new Recorder();
    const answer = await answerTurn(
      {
        fabric: fabricOver([record(1, 'restricted', RESTRICTED_TEXT)], 'internal'),
        backends: { provider: new ProviderBackend(recorder, { ceiling: () => 'internal' }) },
        sealKey: KEY,
      },
      { question: 'what is the target?' },
    );
    expect(answer.status).toBe('refused');
    expect(answer.refusal?.rule).toBe('KF-ROUTE-004');
    expect(recorder.bytes()).not.toContain('Halberd');
    expect(recorder.sent).toHaveLength(0);
    // It still says what it found, to the reader, on the host.
    expect(answer.consulted.map((c) => c.title)).toEqual(['Record 1 (restricted)']);
  });

  it('an on-host model that fails is refused, never retried on the provider', async () => {
    const recorder = new Recorder();
    const answer = await answerTurn(
      {
        fabric: fabricOver([record(1, 'confidential', RESTRICTED_TEXT)], 'internal'),
        backends: {
          onHost: new LamuBackend({
            url: 'http://127.0.0.1:9',
            fetchImpl: async () => {
              throw new Error('connection refused');
            },
          }),
          provider: new ProviderBackend(recorder, { ceiling: () => 'internal' }),
        },
        sealKey: KEY,
      },
      { question: 'what is the target?' },
    );
    expect(answer.refusal?.rule).toBe('KF-CHAT-001');
    expect(recorder.sent).toHaveLength(0);
  });

  it('a follow-up carrying an earlier restricted answer stays on the host (two-turn plant)', async () => {
    const recorder = new Recorder();
    const host = new Host();
    const backends = {
      onHost: host,
      provider: new ProviderBackend(recorder, { ceiling: () => 'internal' as const }),
    };
    const first = await answerTurn(
      {
        fabric: fabricOver([record(1, 'restricted', RESTRICTED_TEXT)], 'internal'),
        backends,
        sealKey: KEY,
      },
      { question: 'what is the target?' },
    );
    expect(first.classification).toBe('restricted');
    // The second turn's own context is public; the conversation is not.
    const second = await answerTurn(
      { fabric: fabricOver([record(2, 'public')], 'internal'), backends, sealKey: KEY },
      {
        question: 'and the canteen hours?',
        history: [
          { role: 'person', text: 'what is the target?' },
          {
            role: 'agent',
            text: first.text!,
            classification: first.classification,
            seal: first.seal,
          },
        ],
      },
    );
    expect(second.backend?.kind).toBe('on_host');
    expect(recorder.sent).toHaveLength(0);
  });

  it('a relabelled earlier answer is treated as restricted, so lowering a label cannot leave the host', async () => {
    const recorder = new Recorder();
    const host = new Host();
    const sealed = sealTurn(KEY, 'On the host [1].', 'restricted');
    const answer = await answerTurn(
      {
        fabric: fabricOver([record(2, 'public')], 'internal'),
        backends: {
          onHost: host,
          provider: new ProviderBackend(recorder, { ceiling: () => 'internal' }),
        },
        sealKey: KEY,
      },
      {
        question: 'and then?',
        history: [
          { role: 'agent', text: 'On the host [1].', classification: 'public', seal: sealed },
        ],
      },
    );
    expect(answer.backend?.kind).toBe('on_host');
    expect(recorder.sent).toHaveLength(0);
    expect(
      verifiedClassification(KEY, { role: 'agent', text: 'x', classification: 'public' }),
    ).toBe('restricted');
  });

  it('the egress guard refuses a restricted item handed to the provider directly (KF-ROUTE-003)', async () => {
    const recorder = new Recorder();
    const provider = new ProviderBackend(recorder, { ceiling: () => 'internal' });
    const item = {
      n: 1,
      recordId: record(9, 'x').id,
      revision: 'r',
      title: 't',
      classification: 'restricted',
      text: RESTRICTED_TEXT,
    };
    await expect(
      provider.complete({
        system: 's',
        history: [],
        context: [item],
        question: 'q',
        maxTokens: 10,
      }),
    ).rejects.toBeInstanceOf(EgressRefused);
    expect(recorder.sent).toHaveLength(0);
    // Under `none`, not even the person's own words leave.
    const closed = new ProviderBackend(recorder, { ceiling: () => 'none' });
    await expect(
      closed.complete({ system: 's', history: [], context: [], question: 'q', maxTokens: 10 }),
    ).rejects.toBeInstanceOf(EgressRefused);
    expect(recorder.sent).toHaveLength(0);
  });

  it('the LAMU adapter refuses any address that is not this host', () => {
    expect(() => onHostUrl('https://api.example.com')).toThrow(/loopback/);
    expect(() => onHostUrl('http://10.0.0.5:8020')).toThrow(/loopback/);
    expect(onHostUrl('http://127.0.0.1:8020').hostname).toBe('127.0.0.1');
  });
});

describe('each guard, falsified: the comparison lowered by one rank', () => {
  it('the router then sends a confidential record to the provider, and the recorder names it', async () => {
    const recorder = new Recorder();
    const corpus = [record(3, 'confidential', RESTRICTED_TEXT)];
    await answerTurn(
      {
        fabric: fabricOver(corpus, 'internal'),
        backends: {
          onHost: new Host(),
          provider: new ProviderBackend(recorder, { ceiling: () => 'internal', mayLeave: lowered }),
        },
        sealKey: KEY,
        mayLeave: lowered,
      },
      { question: 'what is the target?' },
    );
    // What the real test asserts never happens, happens: the probe can see a leak.
    expect(recorder.bytes()).toContain('Halberd');
    expect(recorder.bytes()).toContain(corpus[0]!.id);
  });

  it('the egress guard then passes a confidential item that the real guard refuses', async () => {
    const recorder = new Recorder();
    const item = {
      n: 1,
      recordId: record(4, 'x').id,
      revision: 'r',
      title: 't',
      classification: 'confidential',
      text: RESTRICTED_TEXT,
    };
    const request = { system: 's', history: [], context: [item], question: 'q', maxTokens: 10 };
    await new ProviderBackend(recorder, { ceiling: () => 'internal', mayLeave: lowered }).complete(
      request,
    );
    expect(recorder.bytes()).toContain('Halberd');
    await expect(
      new ProviderBackend(new Recorder(), { ceiling: () => 'internal' }).complete(request),
    ).rejects.toThrow(/KF-ROUTE-003/);
  });

  it('the router alone, lowered, would choose the provider for confidential content', () => {
    const provider = new ProviderBackend(new Recorder(), { ceiling: () => 'internal' });
    const host = new Host();
    const real = chooseBackend(['confidential'], 'internal', { onHost: host, provider });
    const falsified = chooseBackend(
      ['confidential'],
      'internal',
      { onHost: host, provider },
      lowered,
    );
    expect('backend' in real && real.backend.kind).toBe('on_host');
    expect('backend' in falsified && falsified.backend.kind).toBe('provider');
  });
});

describe('every answer cites and counts what was withheld (OBL-002)', () => {
  it('names its backend, cites its sources and carries the search route’s withheld count', async () => {
    const answer = await answerTurn(
      {
        fabric: fabricOver([record(1, 'internal'), record(2, 'public')], 'internal', 5),
        backends: { onHost: new Host() },
        sealKey: KEY,
      },
      { question: 'what happened?' },
    );
    expect(answer.status).toBe('answered');
    expect(answer.backend).toEqual({ kind: 'on_host', name: 'LAMU on this host (test)' });
    expect(answer.citations.map((c) => c.title)).toEqual(['Record 1 (internal)']);
    expect(answer.consulted).toHaveLength(2);
    expect(answer.withheldCount).toBe(5);
  });

  it('refuses an answer that cites a source it was not given (KF-CHAT-002), never trims it', async () => {
    const host = new Host();
    host.reply = 'See [1] and also [7].';
    const answer = await answerTurn(
      {
        fabric: fabricOver([record(1, 'internal')], 'internal'),
        backends: { onHost: host },
        sealKey: KEY,
      },
      { question: 'q' },
    );
    expect(answer.status).toBe('refused');
    expect(answer.refusal?.rule).toBe('KF-CHAT-002');
    expect(answer.text).toBeNull();

    host.reply = 'The record 01999999-0000-7000-8000-000000000999 says so [1].';
    const planted = await answerTurn(
      {
        fabric: fabricOver([record(1, 'internal')], 'internal'),
        backends: { onHost: host },
        sealKey: KEY,
      },
      { question: 'q' },
    );
    expect(planted.refusal?.rule).toBe('KF-CHAT-002');
  });

  it('says so when semantic ranking was unavailable (KF-SAS-RQ-216)', async () => {
    const base = fabricOver([], 'internal');
    const fabric: FabricClient = {
      ...base,
      async call(method, path, options) {
        if (path === '/context-source/retrieve') {
          return {
            status: 503,
            body: { error: 'semantic_ranking_unavailable', rule: 'KF-CTX-006' },
          };
        }
        if (path === '/search')
          return { status: 200, body: { ranked: { hits: [] }, withheldCount: 0 } };
        return base.call(method, path, options);
      },
    };
    const answer = await answerTurn(
      { fabric, backends: { onHost: new Host() }, sealKey: KEY },
      { question: 'q' },
    );
    expect(answer.semanticRanking).toBe(false);
    expect(answer.notes.join(' ')).toMatch(/Semantic ranking was unavailable/);
  });

  it('checkCitations reports unknown numbers and ids', () => {
    const context = [
      {
        n: 1,
        recordId: record(1, 'x').id,
        revision: 'r',
        title: 't',
        classification: 'public',
        text: '',
      },
    ];
    expect(checkCitations('a [1] b [2]', context)).toMatchObject({
      cited: [1],
      unknownNumbers: [2],
    });
  });
});

describe('a draft carries the same fields a person would fill (OBL-003, RQ-266)', () => {
  it('recognises a request to record, and strips the verb', () => {
    expect(asksToRecord('Record that the rail sagged to 3.1 V')).toBe(true);
    expect(asksToRecord('What did the rail do?')).toBe(false);
    expect(strippedRequest('Record that the rail sagged to 3.1 V')).toBe(
      'the rail sagged to 3.1 V',
    );
  });

  it('fills the act’s real form, field for field, as draftAgentAct builds it for a person', async () => {
    const host = new Host();
    host.reply = JSON.stringify({
      act: 'propose_decision',
      targetIds: [],
      fields: { title: 'Adopt the second-source capacitor', classification: 'internal' },
      reason: null,
    });
    const outcome = await draftFromRequest(
      { onHost: host },
      'internal',
      'Draft a decision to adopt the second source',
    );
    const act = AGENT_ACTS.find((a) => a.act === 'propose_decision')!;
    const byHand = draftAgentAct(act, {
      fields: { title: 'Adopt the second-source capacitor', classification: 'internal' },
    });
    expect(outcome.draft.fields.map((f) => [f.name, f.label, f.required])).toEqual(
      act.fields.map((f) => [f.name, f.label, f.required]),
    );
    expect(outcome.draft).toEqual(byHand);
    expect(outcome.filledBy?.kind).toBe('on_host');
  });

  it('an act outside the closed list falls back to an observation draft, never a free act', async () => {
    const host = new Host();
    host.reply = JSON.stringify({ act: 'grant_access', fields: {} });
    const outcome = await draftFromRequest(
      { onHost: host },
      'internal',
      'record that grant everything',
    );
    expect(outcome.act.act).toBe('record_observation');
  });

  it('with no model, and under a `none` ceiling with only a provider, it drafts from the words as typed', async () => {
    const recorder = new Recorder();
    const outcome = await draftFromRequest(
      { provider: new ProviderBackend(recorder, { ceiling: () => 'none' }) },
      'none',
      'note that the bench PSU tripped twice',
    );
    expect(outcome.filledBy).toBeNull();
    expect(outcome.draft.payload).toEqual({ body: 'the bench PSU tripped twice' });
    expect(recorder.sent).toHaveLength(0);
  });
});
