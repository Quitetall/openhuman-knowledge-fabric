import { describe, expect, it } from 'vitest';
import {
  SecureObjectSignerConfigError,
  loadSecureObjectSignerConfig,
} from './config.js';

describe('secure-object signer configuration', () => {
  it('keeps the external signer absent unless explicitly configured', () => {
    expect(loadSecureObjectSignerConfig({}, 'development')).toBeUndefined();
  });

  it('accepts an HTTPS signer endpoint with a bounded timeout', () => {
    expect(
      loadSecureObjectSignerConfig(
        {
          KF_SECURE_OBJECT_ERASURE_SIGNER_URL: 'https://soa.example.test/v1/erasure/sign',
          KF_SECURE_OBJECT_ERASURE_SIGNER_TIMEOUT_MS: '2400',
        },
        'production',
      ),
    ).toEqual({
      endpoint: new URL('https://soa.example.test/v1/erasure/sign'),
      timeoutMs: 2400,
    });
  });

  it('allows cleartext only for a loopback development or test sidecar', () => {
    expect(
      loadSecureObjectSignerConfig(
        { KF_SECURE_OBJECT_ERASURE_SIGNER_URL: 'http://127.0.0.1:9443/sign' },
        'test',
      ),
    ).toEqual({
      endpoint: new URL('http://127.0.0.1:9443/sign'),
      timeoutMs: 5_000,
    });
    expect(() =>
      loadSecureObjectSignerConfig(
        { KF_SECURE_OBJECT_ERASURE_SIGNER_URL: 'http://soa.internal/sign' },
        'development',
      ),
    ).toThrow(/HTTPS or a loopback/);
    expect(() =>
      loadSecureObjectSignerConfig(
        { KF_SECURE_OBJECT_ERASURE_SIGNER_URL: 'http://127.0.0.1:9443/sign' },
        'production',
      ),
    ).toThrow(/HTTPS/);
  });

  it.each([
    'https://user:secret@soa.example.test/sign',
    'https://soa.example.test/sign?key=secret',
    'https://soa.example.test/sign#fragment',
  ])('rejects credential-bearing or ambiguous signer URL %s', (url) => {
    expect(() =>
      loadSecureObjectSignerConfig(
        { KF_SECURE_OBJECT_ERASURE_SIGNER_URL: url },
        'production',
      ),
    ).toThrow(SecureObjectSignerConfigError);
  });

  it('rejects an orphan timeout and out-of-range timeout', () => {
    expect(() =>
      loadSecureObjectSignerConfig(
        { KF_SECURE_OBJECT_ERASURE_SIGNER_TIMEOUT_MS: '1000' },
        'development',
      ),
    ).toThrow(/requires KF_SECURE_OBJECT_ERASURE_SIGNER_URL/);
    expect(() =>
      loadSecureObjectSignerConfig(
        {
          KF_SECURE_OBJECT_ERASURE_SIGNER_URL: 'https://soa.example.test/sign',
          KF_SECURE_OBJECT_ERASURE_SIGNER_TIMEOUT_MS: '0',
        },
        'production',
      ),
    ).toThrow(/1\.\.60000/);
  });
});
