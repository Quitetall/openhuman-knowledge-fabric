import { sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { canonicalBytes, digest } from '@kf/canonicalization';
import type {
  CompleteRunLineage,
  LegacySignedRunSeal,
  MetricSegment,
  PrivateSigningKey,
  RunSealFinding,
  RunSealInput,
  RunSealVerification,
  SignedRunSeal,
} from './contracts.js';
import { createRunLineage } from './lineage.js';
import { createMetricSegment, METRIC_SEGMENT_INPUT_KEYS } from './metric-segments.js';
import {
  SHA256,
  assertExactKeys,
  checkedAggregate,
  checkedEd25519Signature,
  checkedId,
  checkedPositiveInteger,
  checkedTimestamp,
  reject,
} from './validation.js';

function normalizedLineage(lineage: CompleteRunLineage): CompleteRunLineage {
  if (
    lineage === null ||
    typeof lineage !== 'object' ||
    Array.isArray(lineage) ||
    lineage.schemaVersion !== 'kf.ml.run-lineage.v1'
  ) {
    reject('run seal needs a complete v1 run lineage');
  }
  assertExactKeys(
    lineage,
    [
      'schemaVersion',
      'run',
      'code',
      'recipe',
      'environment',
      'metricPolicy',
      'inputs',
      'outputs',
      'parentModels',
    ],
    'run seal.lineage',
  );
  return createRunLineage({
    run: lineage.run,
    code: lineage.code,
    recipe: lineage.recipe,
    environment: lineage.environment,
    metricPolicy: lineage.metricPolicy,
    inputs: lineage.inputs,
    outputs: lineage.outputs,
    parentModels: lineage.parentModels,
  });
}

function normalizedSegment(segment: MetricSegment, index: number): MetricSegment {
  if (
    segment === null ||
    typeof segment !== 'object' ||
    Array.isArray(segment) ||
    segment.schemaVersion !== 'kf.ml.metric-segment.v2'
  ) {
    reject(`run seal.segments[${index}] is not a v2 metric segment`);
  }
  assertExactKeys(
    segment,
    [...METRIC_SEGMENT_INPUT_KEYS, 'schemaVersion', 'eventManifestDigest', 'metadataDigest'],
    `run seal.segments[${index}]`,
  );
  const normalized = createMetricSegment({
    segment: segment.segment,
    run: segment.run,
    ordinal: segment.ordinal,
    firstSequence: segment.firstSequence,
    lastSequence: segment.lastSequence,
    eventCount: segment.eventCount,
    eventDigests: segment.eventDigests,
  });
  if (
    normalized.eventManifestDigest !== segment.eventManifestDigest ||
    normalized.metadataDigest !== segment.metadataDigest
  ) {
    reject(`run seal.segments[${index}] event or metadata digest does not match its fields`);
  }
  return normalized;
}

/** Sign a JCS run-seal payload after checking complete lineage and segment continuity. */
export function signRunSeal(input: RunSealInput, key: PrivateSigningKey): SignedRunSeal {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    reject('run seal input must be an object');
  }
  assertExactKeys(input, ['lineage', 'segments', 'sealedAt'], 'run seal input');
  const lineage = normalizedLineage(input.lineage);
  if (!Array.isArray(input.segments) || input.segments.length === 0) {
    reject('run seal needs at least one metric segment');
  }
  const segments = input.segments.map(normalizedSegment);
  let expectedSequence = 1;
  let eventCount = 0;
  for (const [index, segment] of segments.entries()) {
    if (segment.ordinal !== index + 1 || segment.firstSequence !== expectedSequence) {
      reject('run seal metric segments must be ordinally ordered and sequence-contiguous');
    }
    if (digest(segment.run) !== digest(lineage.run)) {
      reject(`run seal.segments[${index}] belongs to a different run`);
    }
    expectedSequence = segment.lastSequence + 1;
    eventCount += segment.eventCount;
  }
  if (!Number.isSafeInteger(eventCount)) reject('run seal event count exceeds safe integer range');

  const unsigned = Object.freeze({
    schemaVersion: 'kf.ml.run-seal.v2' as const,
    run: lineage.run,
    lineageDigest: digest(lineage),
    segmentDigests: Object.freeze(segments.map((segment) => segment.metadataDigest)),
    eventManifestDigest: digest(segments.flatMap((segment) => segment.eventDigests)),
    eventCount,
    sealedAt: checkedTimestamp(input.sealedAt, 'run seal.sealedAt'),
    signingKeyId: checkedId(key.id, 'run seal.signingKeyId'),
  });
  return Object.freeze({
    ...unsigned,
    sealDigest: digest(unsigned),
    signature: edSign(null, canonicalBytes(unsigned), key.privateKey).toString('base64'),
  });
}

const RUN_SEAL_KEYS = [
  'schemaVersion',
  'run',
  'lineageDigest',
  'segmentDigests',
  'eventManifestDigest',
  'eventCount',
  'sealedAt',
  'signingKeyId',
  'sealDigest',
  'signature',
] as const;

const LEGACY_RUN_SEAL_KEYS = RUN_SEAL_KEYS.filter((key) => key !== 'eventManifestDigest');

/** Verify both the RFC 8785 digest and Ed25519 signature of a run seal. */
export function verifyRunSeal(
  seal: SignedRunSeal | LegacySignedRunSeal,
  publicKeys: ReadonlyMap<string, KeyObject>,
): RunSealVerification {
  const findings: RunSealFinding[] = [];
  try {
    if (seal === null || typeof seal !== 'object' || Array.isArray(seal)) {
      return { valid: false, findings: ['malformed_seal'] };
    }
    const isLegacy = seal.schemaVersion === 'kf.ml.run-seal.v1';
    if (!isLegacy && seal.schemaVersion !== 'kf.ml.run-seal.v2') {
      reject('unsupported run seal version');
    }
    assertExactKeys(seal, isLegacy ? LEGACY_RUN_SEAL_KEYS : RUN_SEAL_KEYS, 'run seal');
    const unsigned = {
      schemaVersion: seal.schemaVersion,
      run: checkedAggregate(seal.run, 'run seal.run', ['run']),
      lineageDigest: SHA256.test(seal.lineageDigest)
        ? seal.lineageDigest
        : reject('bad lineage digest'),
      segmentDigests:
        Array.isArray(seal.segmentDigests) &&
        seal.segmentDigests.length > 0 &&
        seal.segmentDigests.every((entry) => typeof entry === 'string' && SHA256.test(entry))
          ? [...seal.segmentDigests]
          : reject('bad segment digests'),
      ...(isLegacy
        ? {}
        : {
            eventManifestDigest: SHA256.test(seal.eventManifestDigest)
              ? seal.eventManifestDigest
              : reject('bad event manifest digest'),
          }),
      eventCount: checkedPositiveInteger(seal.eventCount, 'run seal.eventCount'),
      sealedAt: checkedTimestamp(seal.sealedAt, 'run seal.sealedAt'),
      signingKeyId: checkedId(seal.signingKeyId, 'run seal.signingKeyId'),
    };
    if (typeof seal.sealDigest !== 'string' || digest(unsigned) !== seal.sealDigest) {
      findings.push('seal_digest_mismatch');
    }
    const signature = checkedEd25519Signature(seal.signature, 'run seal.signature');
    const key = publicKeys.get(unsigned.signingKeyId);
    if (key === undefined) {
      findings.push('unknown_signing_key');
    } else if (!edVerify(null, canonicalBytes(unsigned), key, signature)) {
      findings.push('bad_signature');
    }
  } catch {
    findings.push('malformed_seal');
  }
  return Object.freeze({ valid: findings.length === 0, findings: Object.freeze(findings) });
}
