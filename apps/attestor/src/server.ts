/**
 * kf-attestor's socket server.
 *
 * Three routes. `POST /attest` takes a bearer token and the (organization, acting assignment,
 * ceiling) the caller asked for, runs `resolveCaller` — the one token verifier this codebase has
 * — and answers the attested caller, or 401 with the identity failure. `POST /holdings` takes a
 * bearer token and nothing else, runs `resolveHoldings` over the same verifier, and answers every
 * live assignment the token's own person holds, by organization, or 401 with the same failures
 * (20260926120000); it attests nothing. `GET /health` answers whether the process is up, for the
 * API's readiness.
 *
 * It never logs a token or an attestation, and never answers with more than the API's own
 * identify path did before it moved here: the same failure codes, the same collapsed
 * `invalid_token` for every token defect.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ATTESTOR_HOLDINGS_PATH,
  ATTESTOR_MAX_BODY_BYTES,
  ATTESTOR_PATH,
  IdentityRejected,
  encodeAttestedCaller,
  encodeHoldings,
  encodeRefusal,
  parseAttestorRequest,
  parseHoldingsRequest,
  type Attestor,
} from '@kf/authorization';

export interface AttestorLog {
  (event: string, fields?: Record<string, unknown>): void;
}

const silent: AttestorLog = () => undefined;

class BodyTooLarge extends Error {}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > ATTESTOR_MAX_BODY_BYTES) {
        reject(new BodyTooLarge('request body too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function answer(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  response.end(text);
}

export function createAttestorServer(attestor: Attestor, log: AttestorLog = silent): Server {
  const server = createServer((request, response) => {
    void handle(request, response).catch((err: unknown) => {
      log('attestor_internal_error', { error: err instanceof Error ? err.message : String(err) });
      if (!response.headersSent) answer(response, 500, { failure: 'unavailable' });
      else response.destroy();
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '').split('?')[0];
    if (request.method === 'GET' && path === '/health') {
      answer(response, 200, { status: 'ok' });
      return;
    }
    if (request.method !== 'POST' || (path !== ATTESTOR_PATH && path !== ATTESTOR_HOLDINGS_PATH)) {
      answer(response, 404, { failure: 'not_found' });
      return;
    }
    let raw: string;
    try {
      raw = await readBody(request);
    } catch (err: unknown) {
      if (err instanceof BodyTooLarge) {
        answer(response, 413, { failure: 'too_large' });
        return;
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      answer(response, 400, { failure: 'bad_request' });
      return;
    }
    if (path === ATTESTOR_HOLDINGS_PATH) {
      const holdingsRequest = parseHoldingsRequest(parsed);
      if (holdingsRequest === undefined) {
        answer(response, 400, { failure: 'bad_request' });
        return;
      }
      try {
        const holdings = await attestor.holdings(holdingsRequest.token);
        log('listed', {
          person: holdings.personId,
          organizations: holdings.organizations.length,
        });
        answer(response, 200, encodeHoldings(holdings));
      } catch (err: unknown) {
        if (err instanceof IdentityRejected) {
          log('refused', { failure: err.failure, organization: null });
          const refusal = encodeRefusal(err);
          answer(response, refusal.status, refusal.body);
          return;
        }
        throw err;
      }
      return;
    }
    const callerRequest = parseAttestorRequest(parsed);
    if (callerRequest === undefined) {
      answer(response, 400, { failure: 'bad_request' });
      return;
    }
    try {
      const caller = await attestor.identify(callerRequest);
      log('attested', {
        person: caller.actorId,
        organization: caller.organizationId,
        assignment: caller.actingRoleId,
        ceiling: caller.maxClassification,
        agent: caller.agent ?? null,
      });
      answer(response, 200, encodeAttestedCaller(caller));
    } catch (err: unknown) {
      if (err instanceof IdentityRejected) {
        // `recorded`: whether the refusal is in search.identification_refusal (true), could not be
        // written there (false), or is not one that is recorded (absent).
        log('refused', {
          failure: err.failure,
          organization: callerRequest.organizationId,
          ...(callerRequest.surface === undefined ? {} : { surface: callerRequest.surface }),
          ...(err.recorded === undefined ? {} : { recorded: err.recorded }),
        });
        const refusal = encodeRefusal(err);
        answer(response, refusal.status, refusal.body);
        return;
      }
      throw err;
    }
  }

  // A request that dribbles in holds a socket slot and nothing else; bound it anyway.
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  return server;
}
