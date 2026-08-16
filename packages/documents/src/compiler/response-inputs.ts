import { compareCanonicalText, digestBytes } from '@kf/canonicalization';
import type { CompilationBasis, CompilerInput } from './types.js';
import { expectedCompilerInputs } from './basis.js';
import { exactKeys, fail, nonEmpty, sha256 } from './primitives.js';

export function decodedBase64(value: string, field: string): Buffer {
  if (value.length % 4 !== 0) fail('invalid_base64', `${field} must be canonical base64`);
  const paddingBytes = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const contentLength = value.length - paddingBytes;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (!valid) fail('invalid_base64', `${field} must be canonical base64`);
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value[index] !== '=') fail('invalid_base64', `${field} must be canonical base64`);
  }
  if (contentLength === 0 && paddingBytes > 0) {
    fail('invalid_base64', `${field} must be canonical base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value)
    fail('invalid_base64', `${field} must be canonical base64`);
  return bytes;
}

export function verifiedCompilerInputs(
  basis: CompilationBasis,
  inputs: readonly CompilerInput[],
): readonly CompilerInput[] {
  const expected = expectedCompilerInputs(basis);
  const seen = new Set<string>();
  const verified = inputs.map((input) => {
    exactKeys(input, ['kind', 'id', 'bytesBase64', 'contentDigest'], 'compiler input');
    const key = `${input.kind}:${nonEmpty(input.id, 'compilerInput.id')}`;
    if (seen.has(key)) fail('duplicate_compiler_input', `duplicate compiler input: ${key}`);
    seen.add(key);
    const expectedDigest = expected.get(key);
    if (expectedDigest === undefined) {
      fail('unexpected_compiler_input', `compiler input is not part of the basis: ${key}`);
    }
    sha256(input.contentDigest, `${key}.contentDigest`);
    if (input.contentDigest !== expectedDigest) {
      fail('input_digest_mismatch', `${key} does not match the digest pinned by the basis`);
    }
    const actual = digestBytes(decodedBase64(input.bytesBase64, `${key}.bytesBase64`));
    if (actual !== input.contentDigest) {
      fail('input_digest_mismatch', `${key} bytes do not match their contentDigest`);
    }
    return Object.freeze({
      kind: input.kind,
      id: input.id,
      bytesBase64: input.bytesBase64,
      contentDigest: input.contentDigest,
    });
  });
  const missing = [...expected.keys()].filter((key) => !seen.has(key));
  if (missing.length > 0) {
    fail('missing_compiler_input', `compiler inputs are missing: ${missing.join(', ')}`);
  }
  return Object.freeze(
    verified.sort((left, right) => {
      const leftKey = `${left.kind}:${left.id}`;
      const rightKey = `${right.kind}:${right.id}`;
      return compareCanonicalText(leftKey, rightKey);
    }),
  );
}
