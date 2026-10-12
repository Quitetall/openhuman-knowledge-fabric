import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { composePush, ntfySender, PushFailed, UNDISCLOSED_PUSH, type UrgentRow } from './push.js';

const TOPIC = 'kf-0123456789abcdef0123456789abcdef';

const row: UrgentRow = {
  organizationId: '01900000-0000-7000-8000-000000000002',
  personId: '01900000-0000-7000-8000-000000000010',
  kind: 'proposal_waiting',
  aroseAt: '2026-10-11T10:00:00.000001Z',
  itemId: '01900000-0000-7000-8000-0000000000aa',
  disclosed: true,
  title: 'accept_decision: Adopt the second-source capacitor',
  destination: 'kfpd1.sealed',
};

describe('the push composer (KF-SAS-RQ-274)', () => {
  it('names a disclosed item, and links to Needs you, never to the record', () => {
    const message = composePush(row, 'https://kf.example.test/');
    expect(message.body).toBe('Needs you: accept_decision: Adopt the second-source capacitor');
    expect(message.click).toBe('https://kf.example.test/needs-you');
    expect(JSON.stringify(message)).not.toContain(row.itemId);
  });

  it('never prints a title from a row not marked disclosed, whatever it carries', () => {
    // A planted row: the database said no, and the row still carries the content.
    const message = composePush({ ...row, disclosed: false, title: 'Halberd Aero' });
    expect(message.body).toBe(UNDISCLOSED_PUSH);
    expect(JSON.stringify(message)).not.toContain('Halberd');
  });

  it('keeps the title line fixed', () => {
    expect(composePush(row).title).toBe('Knowledge Fabric');
  });
});

describe('the ntfy sender', () => {
  let server: Server;
  let origin = '';
  let mode: 'echo' | 'fail' | 'wrong' | 'redirect' = 'echo';
  const received: { path: string; title: string | undefined; body: string }[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += String(chunk)));
      request.on('end', () => {
        received.push({ path: request.url ?? '', title: request.headers['title'] as string, body });
        if (mode === 'fail') return response.writeHead(500).end(`no topic ${TOPIC}`);
        if (mode === 'redirect') {
          return response.writeHead(302, { location: 'https://elsewhere.example/' }).end();
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ event: 'message', message: mode === 'wrong' ? 'other' : body }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const message = { title: 'Knowledge Fabric', body: UNDISCLOSED_PUSH };

  it('POSTs the message to the topic and requires ntfy to echo it', async () => {
    mode = 'echo';
    received.length = 0;
    await ntfySender([origin])(`${origin}/${TOPIC}`, message);
    expect(received).toEqual([
      { path: `/${TOPIC}`, title: 'Knowledge Fabric', body: UNDISCLOSED_PUSH },
    ]);
  });

  it.each(['fail', 'wrong', 'redirect'] as const)(
    'fails on %s, naming neither the topic nor the answer',
    async (failure) => {
      mode = failure;
      const error = await ntfySender([origin])(`${origin}/${TOPIC}`, message).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(PushFailed);
      expect(String((error as Error).message)).not.toContain(TOPIC);
      expect(String((error as Error).message)).not.toContain(origin);
    },
  );

  it('refuses a destination on a server this host does not send to, before any request', async () => {
    mode = 'echo';
    received.length = 0;
    await expect(ntfySender(['https://ntfy.sh'])(`${origin}/${TOPIC}`, message)).rejects.toThrow(
      /push server this deployment names/,
    );
    expect(received).toHaveLength(0);
  });
});
