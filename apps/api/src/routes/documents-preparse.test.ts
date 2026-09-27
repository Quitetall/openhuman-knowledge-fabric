import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { ActionRejected, type ActionRequest } from '@kf/actions';
import { InMemoryObjectStore } from '@kf/artifacts';
import { digestBytes } from '@kf/canonicalization';
import type { Pool } from '@kf/database';
import {
  activePreparsedDocuments,
  type DocumentParser,
  type ParsedDocument,
  type PreparsedDocument,
} from '@kf/documents';
import { registerDocumentRoutes } from './documents.js';
import type { DocumentRoutesOptions } from './documents/contracts.js';

/**
 * pandoc runs BEFORE the act's transaction opens, on both doors bytes come in by, and the
 * pre-parse reaches the act in-process — never through the payload.
 *
 * The pool below counts `begin` against `commit`/`rollback`, so "no transaction is open while
 * the parser runs" is a number the parser itself reads at the moment it is called, not an
 * inference from call order.
 */

const ORG = '44444444-4444-7444-8444-444444444444';
const ACTOR = '55555555-5555-7555-8555-555555555555';
const ROLE = '66666666-6666-7666-8666-666666666666';
const FILE = Buffer.from('# Truck 7 maintenance log\n\nBrakes serviced.\n');

function trackedPool(): { pool: Pool; open: () => number } {
  let open = 0;
  const client = {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      const statement = sql.trim().toLowerCase();
      if (statement === 'begin') open += 1;
      if (statement === 'commit' || statement === 'rollback') open -= 1;
      if (sql.includes('core.bind_principal')) return { rows: [{ ceiling: params[3] }] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return {
    pool: { connect: vi.fn(async () => client) } as unknown as Pool,
    open: () => open,
  };
}

/** A slow parser that records how many transactions were open when it ran. */
function slowParser(openAtParse: number[], open: () => number): DocumentParser {
  return {
    async parse(): Promise<ParsedDocument | undefined> {
      openAtParse.push(open());
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Still none open after the wait: nothing started one while pandoc would be running.
      openAtParse.push(open());
      return undefined;
    },
  };
}

function routeOptions(
  pool: Pool,
  parser: DocumentParser,
  execute: DocumentRoutesOptions['executeInTransaction'],
): DocumentRoutesOptions {
  return {
    pool,
    store: new InMemoryObjectStore(),
    documentParser: parser,
    identify: async () => ({
      actorId: ACTOR,
      actingRoleId: ROLE,
      organizationId: ORG,
      maxClassification: 'internal',
      authentication: { authenticatedAt: undefined, assuranceLevel: undefined, methods: [] },
    }),
    preflightInTransaction: vi.fn(async () => undefined),
    executeInTransaction: execute,
  };
}

describe('the parse happens before the transaction', () => {
  it('POST /ingest parses with no transaction open and hands the act a parse of its bytes', async () => {
    const { pool, open } = trackedPool();
    const openAtParse: number[] = [];
    let seen: readonly PreparsedDocument[] | undefined;
    let openAtAct = -1;
    const execute = vi.fn(async (_tx: unknown, request: ActionRequest) => {
      seen = activePreparsedDocuments();
      openAtAct = open();
      expect(request.payload).not.toHaveProperty('preparsed');
      return {
        actionId: 'a1',
        status: 'applied' as const,
        replayed: false,
        objectIds: ['artifact-1'],
        auditDigest: 'd1',
      };
    });
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(
      app,
      routeOptions(pool, slowParser(openAtParse, open), execute as never),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/ingest',
      payload: {
        title: 'truck-7.md',
        artifactKind: 'document',
        classification: 'internal',
        mediaType: 'text/markdown',
        contentBase64: FILE.toString('base64'),
        // A caller naming a pre-parse in the body is ignored: it is not a field anything reads.
        preparsed: { sourceDigest: digestBytes(FILE), mediaType: 'text/markdown', parsed: null },
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(openAtParse).toEqual([0, 0]);
    expect(openAtAct).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen?.[0]).toMatchObject({
      sourceDigest: digestBytes(FILE),
      mediaType: 'text/markdown',
    });
  });

  it('POST /documents parses with no transaction open and hands the act a parse of its bytes', async () => {
    const { pool, open } = trackedPool();
    const openAtParse: number[] = [];
    let seen: readonly PreparsedDocument[] | undefined;
    const execute = vi.fn(async () => {
      seen = activePreparsedDocuments();
      throw new ActionRejected('precondition_failed', 'fixture stops at the act');
    });
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(
      app,
      routeOptions(pool, slowParser(openAtParse, open), execute as never),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/documents',
      payload: {
        title: 'Truck 7',
        documentNumber: 'OH-DOC-TEST-PREPARSE-001',
        revision: 'R01',
        documentClass: 'specification',
        owningRole: 'technical_authority',
        fileName: 'truck-7.md',
        mediaType: 'text/markdown',
        contentBase64: FILE.toString('base64'),
        idempotencyKey: 'preparse-import-0001',
      },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(execute).toHaveBeenCalledOnce();
    expect(openAtParse).toEqual([0, 0]);
    expect(seen?.[0]).toMatchObject({
      sourceDigest: digestBytes(FILE),
      mediaType: 'text/markdown',
    });
  });

  it('refuses a source the parser refuses before storing a byte or opening the act', async () => {
    const { pool } = trackedPool();
    const { DocumentParseRefused } = await import('@kf/documents');
    const parser: DocumentParser = {
      async parse() {
        throw new DocumentParseRefused('timeout', 'pandoc exceeded the parse deadline');
      },
    };
    const execute = vi.fn();
    const options = routeOptions(pool, parser, execute as never);
    const store = options.store as InMemoryObjectStore;
    const put = vi.spyOn(store, 'putIfAbsent');
    const app = Fastify({ logger: false });
    await registerDocumentRoutes(app, options);
    const response = await app.inject({
      method: 'POST',
      url: '/ingest',
      payload: {
        title: 'hostile.md',
        artifactKind: 'document',
        classification: 'internal',
        mediaType: 'text/markdown',
        contentBase64: FILE.toString('base64'),
      },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({ detail: { reason: 'timeout' } });
    expect(put).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
