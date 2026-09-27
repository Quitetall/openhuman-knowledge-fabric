import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { IdentityRejected, TokenVerifier } from './identity.js';

const ISSUER = 'https://idp.example.test/realms/knowledge-fabric';
const AUDIENCE = 'knowledge-fabric-api';

async function verifierAndToken(alg: 'RS256' | 'ES256') {
  const { privateKey, publicKey } = await generateKeyPair(alg);
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k', alg };
  const verifier = new TokenVerifier(
    { issuer: ISSUER, audience: AUDIENCE, jwksUri: 'https://unused.invalid/jwks' },
    createLocalJWKSet({ keys: [jwk] }),
  );
  const token = await new SignJWT({})
    .setProtectedHeader({ alg, kid: 'k' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject('someone')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  return { verifier, token };
}

describe('TokenVerifier algorithm pin', () => {
  it('accepts the algorithm the realm signs with', async () => {
    const { verifier, token } = await verifierAndToken('RS256');
    await expect(verifier.verify(token)).resolves.toMatchObject({ sub: 'someone' });
  });

  it('refuses a token signed with any other algorithm, even by a key in the set', async () => {
    // Without a pin jose lets the token header choose, limited only by which keys the set
    // holds. A key set that ever carries a second key type widens what is accepted silently.
    const { verifier, token } = await verifierAndToken('ES256');
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(IdentityRejected);
  });
});
