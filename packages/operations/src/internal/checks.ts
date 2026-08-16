import type { CheckDefinition } from './contracts.js';
import { backupFreshness } from './backup-check.js';
import { federationFreshness, outboxHealth, searchComplete } from './freshness-checks.js';
import {
  chainIntact,
  checkpointCoverage,
  schemaRelease,
  writeGuardsPresent,
} from './integrity-checks.js';
import { pitrReadiness } from './pitr-check.js';
import { secureObjectStorageEvidence } from './storage-checks.js';

export const SERVICE_CHECKS: readonly CheckDefinition[] = [
  { id: 'schema_release', scope: 'service', run: schemaRelease },
  { id: 'write_guards', scope: 'service', run: writeGuardsPresent },
  { id: 'audit_chain', scope: 'service', run: chainIntact },
  { id: 'outbox_delivery', scope: 'service', run: outboxHealth },
  { id: 'search_index', scope: 'service', run: searchComplete },
];

export const INSTITUTIONAL_CHECKS: readonly CheckDefinition[] = [
  { id: 'checkpoint_coverage', scope: 'institutional', run: checkpointCoverage },
  { id: 'federation_freshness', scope: 'institutional', run: federationFreshness },
  {
    id: 'secure_object_storage_evidence',
    scope: 'institutional',
    run: secureObjectStorageEvidence,
  },
  { id: 'backup_freshness', scope: 'institutional', run: backupFreshness },
  { id: 'pitr_readiness', scope: 'institutional', run: pitrReadiness },
];

export const CHECKS: readonly CheckDefinition[] = [...SERVICE_CHECKS, ...INSTITUTIONAL_CHECKS];
