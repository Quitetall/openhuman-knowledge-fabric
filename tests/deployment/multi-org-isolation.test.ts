/**
 * Tenant isolation across the fixture organizations (fixtures/multi): every corpus's --sample
 * loaded into ONE stack, each as its own KF organization — Redwood Inference, The Agent Company,
 * Lee's Market, MediConn Solutions, Elexion Automotive, and Véracier Industries when its corpus
 * is on this machine — and then, for every ordered pair of organizations A and B, a person of A
 * trying every door into B:
 *
 *   search     B's own words, as A's strongest reader and as A's narrowest: nothing found, and
 *              no withheld count (a count would tell A that B's records exist); a broad search
 *              returns none of B's objects either
 *   read       B's artifacts, B's person and a random id, by every read route: not found — never
 *              forbidden — and the same answer for B's id as for an id that exists nowhere
 *   act        a grant on B's artifact, an observation about it: not found, nothing recorded
 *   context    A's token with B's organization, with B's assignment: refused; B's assignments
 *              are never listed to A, and A's menu of every organization (/session/contexts)
 *              names A's own and nothing of B's
 *
 * Each probe is checked to be able to fail: every organization's probe words ARE found by its own
 * reader (a probe that finds nothing anywhere would prove nothing), and each foreign id is read
 * successfully by its own organization.
 *
 * Opt-in (KF_MULTI_LIVE=1) against a running multi stack (fixtures/multi/stack.sh up) holding
 * the --sample loads; with KF_MULTI_LOAD=1 the test loads them itself, twice, and requires the
 * second load to record nothing new. CI has neither Keycloak nor the stack; the skip says so.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PersonaSession } from '../../fixtures/lib/kf.mjs';
import type { CorpusIds } from '../../fixtures/lib/sessions.mjs';
import type { FixtureOrganization } from '../../fixtures/multi/organizations.mjs';

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..');
const live = process.env['KF_MULTI_LIVE'] === '1';
const load = process.env['KF_MULTI_LOAD'] === '1';

interface Org {
  readonly org: FixtureOrganization;
  readonly ids: CorpusIds;
  readonly strong: PersonaSession;
  readonly narrow: PersonaSession;
  readonly probes: string[];
  /** Every object id the load recorded for this organization. */
  readonly objects: Set<string>;
  readonly artifacts: string[];
}

interface SearchBody {
  lexical: { total: number; hits: { objectId: string }[] };
  semantic?: { hits: { objectId: string }[] };
  withheldCount: number;
}

const RANK: Record<string, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };

async function answer(
  session: PersonaSession,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  try {
    return await session.request(method, route, body, { attempts: 1 });
  } catch (error: unknown) {
    const e = error as { status?: number; body?: unknown };
    if (typeof e.status === 'number') return { status: e.status, body: e.body };
    throw error;
  }
}

/** A response with its per-request noise (request ids) removed, for comparing two answers. */
function stable(body: unknown): unknown {
  return JSON.parse(
    JSON.stringify(body ?? null, (k, v: unknown) => (k === 'requestId' ? undefined : v)),
  );
}

describe.skipIf(!live)(
  'tenant isolation across the fixture organizations (KF_MULTI_LIVE=1)',
  () => {
    const orgs: Org[] = [];

    beforeAll(async () => {
      if (load) {
        for (const pass of ['first', 'second']) {
          const { stdout } = await run(
            process.execPath,
            [join(ROOT, 'fixtures', 'cli.mjs'), 'all', '--sample'],
            { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, timeout: 3_600_000 },
          );
          expect(stdout, `${pass} load`).not.toMatch(/REFUSED/);
          if (pass === 'second') {
            const organizations = stdout.match(/^ {2}organization (created|exists): /gm) ?? [];
            const unchanged = stdout.match(/nothing new: this database already held the fixture/g);
            expect(unchanged?.length, 'every organization reloads as a no-op').toBe(
              organizations.length,
            );
          }
        }
      }
      const { organizations, probeTable } = await import('../../fixtures/multi/organizations.mjs');
      const { corpusSessions } = await import('../../fixtures/lib/sessions.mjs');
      const all = await organizations();
      const probes = await probeTable(all);
      for (const org of all) {
        const { ids, sessionOf } = await corpusSessions(org.id, org.people, {
          personasCorpus: org.personasCorpus,
        });
        const narrowest = [...org.people].sort(
          (a, b) => RANK[a.ceiling]! - RANK[b.ceiling]! || a.key.localeCompare(b.key),
        )[0]!;
        const artifacts = Object.values(ids.documents).flatMap((d) =>
          [d.artifactId, d.textArtifactId].filter((x): x is string => x !== undefined),
        );
        orgs.push({
          org,
          ids,
          strong: sessionOf(org.strong),
          narrow: sessionOf(narrowest.key),
          probes: probes.get(org.id) ?? [],
          objects: new Set([
            ids.organizationId,
            ...artifacts,
            ...Object.values(ids.people).flatMap((p) => [p.personId, p.assignmentId]),
          ]),
          artifacts,
        });
      }
    }, 3_700_000);

    const search = async (session: PersonaSession, q: string) =>
      (await session.request('GET', `/search?q=${encodeURIComponent(q)}&limit=200`))
        .body as SearchBody;

    it('holds at least five organizations, each with probe words and loaded artifacts', () => {
      expect(orgs.length).toBeGreaterThanOrEqual(5);
      expect(new Set(orgs.map((o) => o.ids.organizationId)).size).toBe(orgs.length);
      for (const o of orgs) {
        expect(o.probes.length, `${o.org.id} probe words`).toBeGreaterThan(0);
        expect(o.artifacts.length, `${o.org.id} artifacts`).toBeGreaterThan(0);
      }
    });

    it('finds every organization’s probe words for its own reader (the probe can fail)', async () => {
      for (const o of orgs) {
        for (const word of o.probes) {
          const own = await search(o.strong, word);
          expect(own.lexical.total, `${o.org.id} finds its own "${word}"`).toBeGreaterThan(0);
        }
      }
    });

    it('never shows, finds or counts another organization’s records in search', async () => {
      for (const a of orgs) {
        for (const b of orgs) {
          if (a === b) continue;
          for (const [who, session] of [
            ['strongest', a.strong],
            ['narrowest', a.narrow],
          ] as const) {
            const res = await search(session, b.probes.join(' or '));
            const pair = `${a.org.id} (${who}) → ${b.org.id} [${b.probes.join(', ')}]`;
            const seen = [...res.lexical.hits, ...(res.semantic?.hits ?? [])].map(
              (h) => h.objectId,
            );
            expect(
              seen.filter((id) => b.objects.has(id)),
              `${pair}: ${b.org.id}'s objects`,
            ).toEqual([]);
            expect(res.lexical.total, pair).toBe(0);
            expect(res.withheldCount, `${pair}: withheld count`).toBe(0);
          }
        }
        // A broad search, which does find this organization's own records, finds nobody else's.
        const broad = await search(a.strong, 'report or plan or team or policy or review or data');
        expect(broad.lexical.total, `${a.org.id} broad search`).toBeGreaterThan(0);
        const foreign = broad.lexical.hits
          .map((h) => h.objectId)
          .filter((id) => orgs.some((o) => o !== a && o.objects.has(id)));
        expect(foreign, `${a.org.id} broad search`).toEqual([]);
      }
    });

    it(
      'answers another organization’s object id as not found, never forbidden, and as an id that exists nowhere',
      { timeout: 900_000 },
      async () => {
        for (const [index, a] of orgs.entries()) {
          const b = orgs[(index + 1) % orgs.length]!;
          const nowhere = `01a0d6d3-${randomUUID().slice(9, 13)}-7000-8000-000000000000`;
          // The object view needs a current master record; A compiles its own first.
          const refreshed = await answer(a.strong, 'POST', `/objects/${a.artifacts[0]}/refresh`);
          expect(refreshed.status, `${a.org.id} refreshes its own master record`).toBe(200);
          const targets = [
            ...b.artifacts.slice(0, 3),
            b.ids.people[b.org.strong]!.personId,
            b.ids.organizationId,
          ];
          for (const route of [
            (id: string) => `/objects/${id}`,
            (id: string) => `/objects/${id}/history`,
            (id: string) => `/objects/${id}/available-actions`,
            (id: string) => `/documents/${id}/source`,
            (id: string) => `/projects/${id}`,
          ]) {
            const baseline = await answer(a.strong, 'GET', route(nowhere));
            for (const id of targets) {
              const res = await answer(a.strong, 'GET', route(id));
              const what = `${a.org.id} GET ${route('<' + b.org.id + '>')}`;
              expect(res.status, what).toBe(404);
              expect(stable(res.body), `${what} answers as an id that exists nowhere`).toEqual(
                stable(baseline.body),
              );
            }
          }
          // The same artifact is there for its own organization.
          const own = await answer(b.strong, 'GET', `/documents/${b.artifacts[0]}/source`);
          expect(own.status, `${b.org.id} reads its own artifact`).toBe(200);
        }
      },
    );

    it('refuses acts on another organization’s records as not found, and records nothing', async () => {
      for (const [index, a] of orgs.entries()) {
        const b = orgs[(index + 1) % orgs.length]!;
        const me = a.ids.people[a.org.strong]!.personId;
        const grant = await answer(a.strong, 'POST', '/actions/grant_access', {
          targetIds: [b.artifacts[0]],
          idempotencyKey: `isolation-probe:${randomUUID()}`,
          reason: 'isolation probe: a person of another organization grants themself read',
          payload: { principal_kind: 'person', principal_id: me, capability: 'read' },
        });
        expect(grant.status, `${a.org.id} grant_access on ${b.org.id}`).toBe(404);
        expect(grant.body).toMatchObject({ error: 'object_not_visible' });
        const note = await answer(a.strong, 'POST', '/capture/observation', {
          body: 'isolation probe',
          subjects: [b.artifacts[0]],
          gesture_id: `iso-${randomUUID()}`,
        });
        expect(note.status, `${a.org.id} observation about ${b.org.id}`).toBe(404);
        expect(note.body).toMatchObject({ error: 'object_not_visible' });
        // And the probe's words stay unreachable: nothing above became a way in.
        expect((await search(a.strong, b.probes.join(' or '))).lexical.total).toBe(0);
      }
    });

    it('refuses a context in another organization, and never lists its assignments', async () => {
      const { PersonaSession: Session } = await import('../../fixtures/lib/kf.mjs');
      const { stackSettings } = await import('../../fixtures/lib/stack.mjs');
      const settings = stackSettings();
      for (const [index, a] of orgs.entries()) {
        const b = orgs[(index + 1) % orgs.length]!;
        const person = a.org.people.find((p) => p.key === a.org.strong)!;
        const token = await a.strong.token();
        const forged = (organizationId: string, assignmentId: string) =>
          new Session({
            oidc: settings.oidc,
            apiOrigin: settings.api,
            person,
            password: undefined,
            organizationId,
            assignmentId,
          });
        for (const [what, session] of [
          [
            'B’s organization, A’s assignment',
            forged(b.ids.organizationId, a.ids.people[a.org.strong]!.assignmentId),
          ],
          [
            'B’s organization, B’s assignment',
            forged(b.ids.organizationId, b.ids.people[b.org.strong]!.assignmentId),
          ],
          [
            'A’s organization, B’s assignment',
            forged(a.ids.organizationId, b.ids.people[b.org.strong]!.assignmentId),
          ],
        ] as const) {
          // The forged session signs nobody in: it carries A's own current token.
          Object.defineProperty(session, 'token', { value: () => Promise.resolve(token) });
          const res = await answer(session, 'GET', `/search?q=${encodeURIComponent(b.probes[0]!)}`);
          expect([401, 403], `${a.org.id} → ${what}: ${JSON.stringify(res.body)}`).toContain(
            res.status,
          );
          // The menu route ignores the acting role; asked about B's organization it has nothing
          // to offer A, and asked about A's it offers A's own assignments only.
          const listed = await answer(session, 'GET', '/session/assignments');
          if (what.startsWith('B’s organization'))
            expect(listed.status, `${a.org.id} → ${what}: assignments`).not.toBe(200);
          const text = JSON.stringify(listed.body);
          for (const p of Object.values(b.ids.people)) expect(text).not.toContain(p.assignmentId);
          // Every organization's menu (20260926120000) is the token's own person's, whatever
          // the request names: A's organization under its legal name, and nothing of B's.
          const everywhere = await answer(session, 'GET', '/session/contexts');
          expect(everywhere.status, `${a.org.id} → ${what}: contexts`).toBe(200);
          const menu = everywhere.body as {
            organizations: { organizationId: string; legalName: string }[];
          };
          expect(
            menu.organizations.find((o) => o.organizationId === a.ids.organizationId)?.legalName,
            `${a.org.id} → ${what}: its own organization is listed`,
          ).toBe(a.org.legalName);
          const all = JSON.stringify(everywhere.body);
          expect(all).not.toContain(b.ids.organizationId);
          expect(all).not.toContain(JSON.stringify(b.org.legalName).slice(1, -1));
          for (const p of Object.values(b.ids.people)) expect(all).not.toContain(p.assignmentId);
        }
      }
    });
  },
);
