/**
 * Read-only federation adapters
 *
 * Records external identity, revision and digest; never copies the fact. An adapter that
 * creates dual authority is a defect.
 */

import type { PackageManifest } from '@kf/domain';

export const PACKAGE: PackageManifest = {
  name: '@kf/integration',
  role: 'Read-only federation adapters',
  owns: [],
};

export {
  FederationRejected,
  StaticSourceReader,
  checkDrift,
  digestOf,
  linkToReference,
  recordReference,
  type DriftFinding,
  type FederatedReference,
  type ReferenceSpec,
  type SourceReader,
} from './federation.js';
