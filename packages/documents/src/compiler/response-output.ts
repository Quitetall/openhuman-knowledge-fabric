import { compareCanonicalText, digestBytes } from '@kf/canonicalization';
import type {
  CompilationBasis,
  CompilationDiagnostic,
  CompiledView,
  CompilerResponse,
  ConversionLoss,
} from './types.js';
import { exactKeys, fail, nonEmpty, sha256 } from './primitives.js';
import { decodedBase64 } from './response-inputs.js';

export function verifiedDiagnostic(input: CompilationDiagnostic): CompilationDiagnostic {
  exactKeys(input, ['severity', 'code', 'message'], 'diagnostic');
  if (input.severity !== 'info' && input.severity !== 'warning' && input.severity !== 'error') {
    fail('malformed_response', `unknown diagnostic severity: ${String(input.severity)}`);
  }
  return Object.freeze({
    severity: input.severity,
    code: nonEmpty(input.code, 'diagnostic.code'),
    message: nonEmpty(input.message, 'diagnostic.message'),
  });
}

export function verifiedConversionLoss(input: ConversionLoss): ConversionLoss {
  exactKeys(input, ['code', 'path', 'message'], 'conversion loss');
  return Object.freeze({
    code: nonEmpty(input.code, 'conversionLoss.code'),
    path: input.path === null ? null : nonEmpty(input.path, 'conversionLoss.path'),
    message: nonEmpty(input.message, 'conversionLoss.message'),
  });
}

export function verifiedViews(
  response: CompilerResponse,
  basis: CompilationBasis,
): readonly CompiledView[] {
  const expectedTargets = new Set(basis.targetProfiles.map((profile) => profile.target));
  const seen = new Set<string>();
  const views = response.views.map((view) => {
    exactKeys(view, ['target', 'mediaType', 'bytesBase64', 'contentDigest'], 'compiled view');
    const target = nonEmpty(view.target, 'view.target');
    if (!expectedTargets.has(target)) {
      fail('unexpected_view', `compiler returned undeclared target: ${target}`);
    }
    if (seen.has(target)) fail('duplicate_view', `compiler returned target twice: ${target}`);
    seen.add(target);
    sha256(view.contentDigest, `view.${target}.contentDigest`);
    const actual = digestBytes(decodedBase64(view.bytesBase64, `view.${target}.bytesBase64`));
    if (actual !== view.contentDigest) {
      fail('view_digest_mismatch', `compiled view ${target} bytes do not match its digest`);
    }
    return Object.freeze({
      target,
      mediaType: nonEmpty(view.mediaType, `view.${target}.mediaType`),
      bytesBase64: view.bytesBase64,
      contentDigest: view.contentDigest,
      effectiveClassification: basis.effectiveClassification,
    });
  });
  const missing = [...expectedTargets].filter((target) => !seen.has(target));
  if (missing.length > 0) fail('missing_view', `compiler omitted targets: ${missing.join(', ')}`);
  return Object.freeze(
    views.sort((left, right) => compareCanonicalText(left.target, right.target)),
  );
}
