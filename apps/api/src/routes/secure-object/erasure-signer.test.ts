import { describe, expect, it, vi } from 'vitest';
import {
  SecureObjectRejected,
  externalAuthorityRef,
  type SignedErasureTombstonePayload,
} from '@kf/integration';
import { HttpErasureAuthoritySigner } from './erasure-signer.js';

const canonical = Buffer.from('{"exact":"tombstone"}', 'utf8');
const signature = Buffer.alloc(64, 7);

function response(
  overrides: Partial<{
    version: string;
    signing_key_registry_id: string;
    canonical_tombstone_base64: string;
    signature_base64: string;
  }> = {},
): Response {
  return new Response(
    JSON.stringify({
      version: 'kf-secure-object-erasure-signature/v1',
      signing_key_registry_id: '019b0000-0000-7000-8000-000000000001',
      canonical_tombstone_base64: canonical.toString('base64'),
      signature_base64: signature.toString('base64'),
      ...overrides,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

const input = {
  organizationId: '019b0000-0000-7000-8000-000000000002',
  authorityRef: externalAuthorityRef('authority:secure-object'),
  signingKeyRegistryId: '019b0000-0000-7000-8000-000000000001',
  canonicalTombstoneBytes: canonical,
  signal: new AbortController().signal,
};

describe('HTTP erasure authority signer', () => {
  it('sends only exact non-PHI signing context and returns a decoded signed payload', async () => {
    const fetcher = vi.fn(async () => response());
    const signer = new HttpErasureAuthoritySigner(
      { endpoint: new URL('https://soa.example.test/v1/erasure/sign'), timeoutMs: 5_000 },
      fetcher,
    );

    const signed = await signer.sign(input);

    expect(signed).toEqual<SignedErasureTombstonePayload>({
      version: 'kf-secure-object-erasure-signature/v1',
      signingKeyRegistryId: input.signingKeyRegistryId,
      canonicalTombstoneBytes: canonical,
      signature,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe('https://soa.example.test/v1/erasure/sign');
    expect(init).toMatchObject({
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      signal: input.signal,
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      version: 'kf-secure-object-erasure-sign-request/v1',
      organization_id: input.organizationId,
      external_authority_ref: input.authorityRef,
      signing_key_registry_id: input.signingKeyRegistryId,
      canonical_tombstone_base64: canonical.toString('base64'),
    });
  });

  it.each([
    ['wrong key', { signing_key_registry_id: '019b0000-0000-7000-8000-000000000099' }],
    ['wrong payload', { canonical_tombstone_base64: Buffer.from('wrong').toString('base64') }],
    ['noncanonical signature', { signature_base64: `${signature.toString('base64').slice(0, -2)}AB` }],
  ])('rejects a %s instead of accepting caller-selected receipt material', async (_name, body) => {
    const signer = new HttpErasureAuthoritySigner(
      { endpoint: new URL('https://soa.example.test/sign'), timeoutMs: 5_000 },
      async () => response(body),
    );

    await expect(signer.sign(input)).rejects.toMatchObject<Partial<SecureObjectRejected>>({
      failure: 'signing_key_unavailable',
    });
  });

  it('rejects non-JSON, oversized, extra-field, and non-success responses without reflecting them', async () => {
    const cases = [
      new Response('<html>private error</html>', { status: 502 }),
      new Response('x'.repeat(33_000), { status: 200 }),
      new Response(JSON.stringify({ extra: true }), { status: 200 }),
      new Response(JSON.stringify({ ...JSON.parse(await response().text()), private_key: 'no' }), {
        status: 200,
      }),
    ];
    for (const external of cases) {
      const signer = new HttpErasureAuthoritySigner(
        { endpoint: new URL('https://soa.example.test/sign'), timeoutMs: 5_000 },
        async () => external,
      );
      await expect(signer.sign(input)).rejects.toThrow(/external erasure signer/);
      await expect(signer.sign(input)).rejects.not.toThrow(/private error|private_key/);
    }
  });
});
