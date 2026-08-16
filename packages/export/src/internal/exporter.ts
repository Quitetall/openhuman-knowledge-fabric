import { canonicalize, compareCanonicalText, digestBytes } from '@kf/canonicalization';
import type { Tx } from '@kf/database';
import type { CreateExportOptions, ExportFile, ExportManifest, ExportPackage } from './types.js';
import { EXPORT_FORMAT_VERSION } from './types.js';
import { MANIFEST_PATH, PRESERVATION_TEXT_PARSERS, STRICT_SNAPSHOT_TOKEN } from './format.js';
import {
  canonicalRowOrder,
  exactAuditSequence,
  file,
  normalize,
  recomputeDatabaseSnapshotDigest,
  type Row,
} from './encoding.js';
import { SECTIONS } from './sections.js';

export async function createExport(
  tx: Tx,
  options: CreateExportOptions = {},
): Promise<ExportPackage> {
  const snapshotToken = options.strictSnapshotToken;
  if (snapshotToken !== undefined && !STRICT_SNAPSHOT_TOKEN.test(snapshotToken)) {
    throw new Error('strict PostgreSQL snapshot token has an invalid closed-form value');
  }

  // Must be the transaction's first database statement. PostgreSQL refuses isolation or
  // snapshot changes after any query has established visibility, which turns accidental
  // mixed-snapshot exports into a hard failure.
  await tx.query('set transaction isolation level repeatable read, read only');
  if (snapshotToken !== undefined) {
    // Closed-form validation above makes interpolation safe; PostgreSQL has no bind-parameter
    // form for SET TRANSACTION SNAPSHOT.
    await tx.query(`set transaction snapshot '${snapshotToken}'`);
  }
  await tx.query("set local time zone 'UTC'");

  const preservingQuery = <R extends Row = Row>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> => tx.queryWithTextParsers<R>(sql, params, PRESERVATION_TEXT_PARSERS);

  const release = await tx.one<{ version: string; ontology_digest: string }>(
    'select version, ontology_digest from registry.schema_release where is_current',
  );

  const files: ExportFile[] = [];
  const counts: Record<string, number> = {};

  // The ontology travels WITH the data. Without it, a reader in twenty years has rows whose
  // state and action tokens mean nothing.
  const ontology = {
    object_types: canonicalRowOrder(
      await preservingQuery('select * from registry.object_type order by id'),
    ),
    relation_types: canonicalRowOrder(
      await preservingQuery('select * from registry.relation_type order by id'),
    ),
    action_types: canonicalRowOrder(
      await preservingQuery('select * from registry.action_type order by id'),
    ),
    state_machines: canonicalRowOrder(
      await preservingQuery('select * from registry.state_machine order by id'),
    ),
    object_states: canonicalRowOrder(
      await preservingQuery('select * from registry.object_state order by object_type, state'),
    ),
    state_transitions: canonicalRowOrder(
      await preservingQuery(
        'select * from registry.state_transition order by object_type, from_state, to_state, action_id',
      ),
    ),
    rules: canonicalRowOrder(
      await preservingQuery('select * from registry.rule_definition order by id'),
    ),
    classifications: canonicalRowOrder(
      await preservingQuery('select * from registry.classification order by rank'),
    ),
    retention_classes: canonicalRowOrder(
      await preservingQuery('select * from registry.retention_class order by id'),
    ),
  };
  files.push(file('ontology/registry.json', ontology));

  let auditRows: readonly Row[] = [];
  for (const section of SECTIONS) {
    const queried = (await preservingQuery(section.sql)).map(normalize);
    // Audit chain order is its bigint sequence, not canonical row bytes. SQL's numeric order
    // is locale-independent and audit_from/to rely on first/last retaining chain order.
    const rows = section.name === 'audit-events' ? queried : canonicalRowOrder(queried);
    if (section.name === 'audit-events') auditRows = rows;
    counts[section.name] = rows.length;
    files.push(file(`${section.name}.json`, rows));
  }

  files.sort((a, b) => compareCanonicalText(a.path, b.path));

  const auditFrom =
    auditRows.length === 0
      ? null
      : exactAuditSequence(auditRows[0]?.['seq'], 'first exported audit sequence');
  const auditTo =
    auditRows.length === 0
      ? null
      : exactAuditSequence(
          auditRows[auditRows.length - 1]?.['seq'],
          'last exported audit sequence',
        );

  const manifest: ExportManifest = {
    format_version: EXPORT_FORMAT_VERSION,
    ontology_version: release.version,
    ontology_digest: release.ontology_digest,
    schema_version: release.version,
    audit_from_seq: auditFrom,
    audit_to_seq: auditTo,
    database_snapshot_sha256: recomputeDatabaseSnapshotDigest(files),
    counts,
    // The manifest does NOT list itself: a file cannot contain its own hash. Verifying the
    // manifest is a separate act — signing it.
    files: files.map((f) => {
      const bytes = Buffer.from(f.content, 'utf8');
      return { path: f.path, size_bytes: bytes.length, sha256: digestBytes(bytes) };
    }),
  };

  return {
    files: [...files, { path: MANIFEST_PATH, content: `${canonicalize(manifest)}\n` }],
    manifest,
  };
}
