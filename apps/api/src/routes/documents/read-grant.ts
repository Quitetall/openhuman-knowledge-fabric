/**
 * The read gate lives in `@kf/authorization` (`packages/authorization/src/read-grant.ts`), so the
 * agent tools ask the same question the API does (KF-SAS-RQ-039, RQ-041). This module re-exports
 * it for the routes that still import it by this path.
 */
export {
  classificationsOf,
  reaches,
  readCoverage,
  readGranted,
  readGrantedSubset,
  type Classified,
  type ReadIdentity,
} from '@kf/authorization';
