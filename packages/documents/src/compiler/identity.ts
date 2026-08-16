import type { CompilerIdentity } from './core-types.js';
import { exactKeys, fail, GIT_COMMIT, nonEmpty, SHA256, sha256 } from './primitives.js';

export function compilerIdentity(input: CompilerIdentity): CompilerIdentity {
  if (input.protocol !== 'kf-document-v1') {
    fail('unsupported_protocol', `unsupported compiler protocol: ${String(input.protocol)}`);
  }
  if (input.kind === 'in_memory') {
    exactKeys(
      input,
      ['kind', 'name', 'version', 'protocol', 'executableDigest'],
      'in-memory compiler identity',
    );
    return Object.freeze({
      kind: input.kind,
      name: nonEmpty(input.name, 'compiler.name'),
      version: nonEmpty(input.version, 'compiler.version'),
      protocol: input.protocol,
      executableDigest: sha256(input.executableDigest, 'compiler.executableDigest'),
    });
  }
  if (input.kind === 'liminal') {
    exactKeys(
      input,
      [
        'kind',
        'name',
        'version',
        'protocol',
        'commitSha',
        'cargoLockDigest',
        'executableDigest',
        'runtimeClosureDigest',
        'qualification',
      ],
      'Liminal compiler identity',
    );
    if (!GIT_COMMIT.test(input.commitSha)) {
      fail('invalid_git_commit', 'compiler.commitSha must be a full lowercase commit');
    }
    exactKeys(
      input.qualification,
      ['state', 'receiptDigest', 'ratified'],
      'compiler qualification',
    );
    if (
      input.qualification.receiptDigest !== null &&
      !SHA256.test(input.qualification.receiptDigest)
    ) {
      fail('invalid_digest', 'compiler qualification receiptDigest must be a SHA-256 digest');
    }
    if (
      input.qualification.state === 'qualified' &&
      (!input.qualification.ratified || input.qualification.receiptDigest === null)
    ) {
      fail(
        'unqualified_compiler',
        'a qualified compiler requires a ratified qualification receipt',
      );
    }
    if (input.qualification.state !== 'qualified' && input.qualification.ratified) {
      fail('invalid_qualification', 'an incomplete qualification cannot be ratified');
    }
    return Object.freeze({
      kind: input.kind,
      name: nonEmpty(input.name, 'compiler.name'),
      version: nonEmpty(input.version, 'compiler.version'),
      protocol: input.protocol,
      commitSha: input.commitSha,
      cargoLockDigest: sha256(input.cargoLockDigest, 'compiler.cargoLockDigest'),
      executableDigest: sha256(input.executableDigest, 'compiler.executableDigest'),
      runtimeClosureDigest: sha256(input.runtimeClosureDigest, 'compiler.runtimeClosureDigest'),
      qualification: Object.freeze({ ...input.qualification }),
    });
  }
  return fail('unknown_compiler', 'compiler kind is not supported');
}
