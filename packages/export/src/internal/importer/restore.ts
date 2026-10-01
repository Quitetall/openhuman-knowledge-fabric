import type { Tx } from '@kf/database';
import { IMPORT_ORDER, LEGACY_V1_IMPORT_ORDER } from '../import-order.js';
import { assertUserTriggersEnabled, setUserTriggers } from '../import-support.js';
import type { ExportPackage, ExportVerificationOptions } from '../types.js';
import { EXPORT_FORMAT_VERSION } from '../types.js';
import { predatedSections } from '../section-eras.js';
import { verifyExport } from '../verifier.js';
import { assertRestoredAuditChain } from './audit-chain.js';
import { assertActionTargetScope, assertLegacyActionProvenance } from './legacy-actions.js';
import { assertMasterRecordItems } from './master-record.js';
import { restoreSections } from './sections.js';

/** Import an authenticated export into an empty, migrated database. */
export async function importExport(
  tx: Tx,
  pkg: ExportPackage,
  verification: ExportVerificationOptions = {},
): Promise<{ imported: number }> {
  const findings = verifyExport(pkg, verification);
  if (findings.length > 0) {
    throw new Error(
      `refusing to import an export that fails its own manifest: ${findings
        .map((finding) => `${finding.path} ${finding.problem} (${finding.detail})`)
        .join(', ')}`,
    );
  }
  const importOrder = resolveImportOrder(pkg);
  // Format 1, and a format-2 archive written before b240779c, predate storage locations
  // (20260902000200, ADR 0017). The verifier has already held `artifact-stores` and
  // `artifact-locations` absent together.
  const predatesStorageLocations =
    pkg.manifest.format_version === '1' || predatedSections(pkg).has('artifact-stores');
  await tx.query('set constraints all deferred');
  await assertUserTriggersEnabled(tx, 'before restore');
  let triggersMayBeDisabled = true;
  try {
    await setUserTriggers(tx, false);
    if (pkg.manifest.format_version === EXPORT_FORMAT_VERSION) {
      await tx.query('delete from quality.federated_source');
      // The roles are the migrations' seed, and a migration can add one after an archive was
      // written (20260911000100 seeded customer_contact and partner_contact). The target is an
      // empty database, so what it holds now is exactly that seed: keep it aside and restore any
      // role the archive predates once the archive's own roles are in.
      await tx.query('create temporary table seeded_role on commit drop as select * from org.role');
      await tx.query('delete from org.role');
      // Migration 20260902000200 seeds the `working` store; a package written since carries
      // every store the source declared, including that one. A package written before it has
      // no stores, and the seeded `working` store is the one the migration would have declared.
      if (!predatesStorageLocations) await tx.query('delete from content.artifact_store');
    }

    const restored = await restoreSections(tx, pkg, importOrder);
    if (pkg.manifest.format_version === EXPORT_FORMAT_VERSION) {
      await tx.query(
        `insert into org.role select * from seeded_role
          where id not in (select id from org.role)`,
      );
      await tx.query('drop table seeded_role');
    }
    if (pkg.manifest.format_version === '1' && restored.legacyActionIds.length > 0) {
      await tx.query(
        `insert into core.action_migration019_legacy (action_id)
         select action_id from unnest($1::uuid[]) restored(action_id)`,
        [restored.legacyActionIds],
      );
    }
    if (predatesStorageLocations) {
      // The package predates storage locations and triggers are off during restore, so the
      // working location every addressed version would have had is recorded here, exactly as
      // the migration backfilled it.
      await tx.query(
        `insert into content.artifact_location
           (version_id, store_id, role, uri, store_version, recorded_at)
         select v.id, 'working', 'working', v.storage_uri, v.storage_version, v.created_at
           from content.artifact_version v
          where v.storage_uri is not null
            and not exists (select 1 from content.artifact_location l
                             where l.version_id = v.id and l.role = 'working')`,
      );
    }
    await assertMasterRecordItems(tx);
    await assertLegacyActionProvenance(tx);
    await assertActionTargetScope(tx);
    await assertRestoredAuditChain(tx);
    await rebuildDerivedAuditState(tx);

    await tx.query('set constraints all immediate');
    await setUserTriggers(tx, true);
    triggersMayBeDisabled = false;
    await assertUserTriggersEnabled(tx, 'after constraint validation');
    return { imported: restored.imported };
  } catch (error: unknown) {
    if (triggersMayBeDisabled) {
      try {
        await tx.query('set constraints all immediate');
        await setUserTriggers(tx, true);
        triggersMayBeDisabled = false;
        await assertUserTriggersEnabled(tx, 'while unwinding failed restore');
      } catch {
        // Preserve the original failure; rollback restores DDL in an aborted transaction.
      }
    }
    try {
      await tx.query('select 1 / 0 as force_preservation_restore_rollback');
    } catch {
      // Expected: transaction is now aborted, or the original SQL error already aborted it.
    }
    throw error;
  }
}

function resolveImportOrder(pkg: ExportPackage): readonly string[] {
  if (pkg.manifest.format_version === EXPORT_FORMAT_VERSION) return IMPORT_ORDER;
  if (pkg.manifest.format_version === '1') return LEGACY_V1_IMPORT_ORDER;
  throw new Error(
    `unsupported export format version ${JSON.stringify(pkg.manifest.format_version)}`,
  );
}

async function rebuildDerivedAuditState(tx: Tx): Promise<void> {
  await tx.query(
    `update core.audit_chain_head head
        set (seq, digest) = (
          select coalesce(event.seq, 0), coalesce(event.digest, repeat('0', 64))
            from (select 1) seed
            left join lateral (
              select audit.seq, audit.digest from core.audit_event audit
               order by audit.seq desc limit 1
            ) event on true
        )
      where head.singleton`,
  );
  await tx.query(
    `select setval(
              pg_get_serial_sequence('core.audit_event', 'seq'),
              coalesce(max(seq), 1),
              max(seq) is not null
            )
       from core.audit_event`,
  );
}
