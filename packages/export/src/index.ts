/**
 * Preservation export, import and round-trip.
 *
 * Retention here is unbounded — ISO 13485 §4.2.5 requires at least the device lifetime, and
 * that lifetime is currently undefined — so records created now must stay readable
 * indefinitely. No database binary format survives that horizon: a 2026 PGDATA will not
 * mount on a 2045 server, and major-version migration is mandatory every few years.
 *
 * So THIS is the institutional record, and PostgreSQL is the operational engine over it.
 * Plain RFC 8785 canonical JSON with a manifest of SHA-256 digests: readable by anything
 * that can read text, verifiable by anything that can hash.
 *
 * The round trip — export, import into an empty database, export again, compare — is what
 * keeps that claim true rather than aspirational. It also makes the engine replaceable:
 * given a passing round trip, "the database died" is a restore rather than a loss.
 */

import { canonicalize, digest as digestOf, digestBytes } from '@kf/canonicalization';
import type { Tx } from '@kf/database';

export interface ExportFile {
  /** Path relative to the export root. */
  readonly path: string;
  readonly content: string;
}

export interface ExportPackage {
  readonly files: readonly ExportFile[];
  readonly manifest: ExportManifest;
}

export interface ExportManifest {
  readonly format_version: string;
  readonly ontology_version: string;
  readonly ontology_digest: string;
  readonly schema_version: string;
  /** Range of audit sequence numbers this export covers. */
  readonly audit_from_seq: number | null;
  readonly audit_to_seq: number | null;
  readonly counts: Readonly<Record<string, number>>;
  readonly files: readonly { path: string; size_bytes: number; sha256: string }[];
}

/** The export format's own version, independent of the ontology's. */
export const EXPORT_FORMAT_VERSION = '1';

/**
 * PostgreSQL's wire protocol caps bind parameters at 65535 per statement. Batched inserts on
 * import are sized to stay under it — exceeding it fails at the protocol layer with an error
 * that says nothing about which restore step overran.
 */
const MAX_BIND_PARAMETERS = 60000;

/**
 * Every table the export carries, with the deterministic order rows appear in.
 *
 * Order is part of the format. Without a total order, two exports of identical data would
 * differ by row order and the round-trip comparison would be meaningless — and PostgreSQL
 * gives no ordering guarantee without ORDER BY.
 */
const SECTIONS = [
  {
    name: 'objects',
    sql: `select id, enterprise_id, object_type, authority_domain, lifecycle_state,
                 classification, retention_class, schema_version, organization_id,
                 row_version, title, created_at, created_by, updated_at, updated_by
            from core.object order by id`,
  },
  {
    name: 'relations',
    sql: `select id, relation_type, source_id, target_id, state, properties,
                 valid_from, valid_to, created_at, created_by, authorizing_action
            from core.relation order by id`,
  },
  {
    name: 'actions',
    sql: `select id, action_type, actor_id, acting_role_id, target_ids, parameters,
                 preconditions, idempotency_key, recorded_at, effective_at, request_id,
                 reason, result_status, result
            from core.action order by id`,
  },
  {
    name: 'approvals',
    sql: `select id, object_id, action_id, approver_id, approver_role, meaning,
                 recorded_at, effective_at
            from core.approval order by id`,
  },
  {
    name: 'snapshots',
    sql: `select id, object_id, action_id, object_revision, payload, payload_sha256,
                 ontology_digest, storage_uri, recorded_at
            from core.snapshot order by id`,
  },
  {
    name: 'audit-events',
    // Ordered by seq, not id: the chain is DEFINED over this order, so exporting it any
    // other way would make the imported chain unverifiable.
    sql: `select seq, id, action_id, actor_id, acting_role_id, action_type, object_id,
                 recorded_at, effective_at, request_id, reason, before_digest, after_digest,
                 prev_digest, digest
            from core.audit_event order by seq`,
  },
  {
    name: 'audit-checkpoints',
    sql: `select id, from_seq, to_seq, leaf_count, merkle_root, signature, signing_key_id,
                 storage_uri, recorded_at
            from core.audit_checkpoint order by from_seq`,
  },
  {
    name: 'artifacts',
    // The INDEX, not the bytes. Restoring a system means restoring this alongside the object
    // store; the digest is what proves the two still agree.
    //
    // Artifacts and versions are separate sections rather than one convenient join, because
    // a join cannot be imported: its columns span two tables, so an export shaped that way
    // would look complete and restore as nothing.
    sql: 'select id, artifact_kind, source_system from content.artifact order by id',
  },
  {
    name: 'artifact-versions',
    sql: `select id, artifact_id, version_no, revision_label, sha256, size_bytes, media_type,
                 storage_uri, storage_version, created_at, created_by, created_by_action
            from content.artifact_version order by artifact_id, version_no`,
  },
  {
    name: 'artifact-relationships',
    sql: `select id, from_version, to_version, relationship, created_at
            from content.artifact_relationship order by id`,
  },
  {
    name: 'external-identifiers',
    sql: `select id, version_id, system, external_id, uri, authority, synced_at
            from content.external_locator order by version_id, system, external_id`,
  },
  {
    name: 'organizations',
    sql: `select id, legal_name, organization_kind, jurisdiction from org.organization order by id`,
  },
  {
    name: 'people',
    sql: 'select id, display_name, organization, email from org.person order by id',
  },
  {
    name: 'engagements',
    sql: `select id, principal_organization, counterparty, engagement_kind, starts_on,
                 ends_on, agreement_artifact
            from org.engagement order by id`,
  },
  {
    name: 'role-assignments',
    sql: `select id, subject_id, role_id, scope_id, valid_from, valid_to, delegated_by
            from org.role_assignment order by id`,
  },
] as const;

/** Section name -> the table it restores into, for import. */
const IMPORT_TARGETS: Record<string, string> = {
  objects: 'core.object',
  relations: 'core.relation',
  actions: 'core.action',
  approvals: 'core.approval',
  snapshots: 'core.snapshot',
  'audit-events': 'core.audit_event',
  'audit-checkpoints': 'core.audit_checkpoint',
  organizations: 'org.organization',
  people: 'org.person',
  engagements: 'org.engagement',
  'role-assignments': 'org.role_assignment',
  artifacts: 'content.artifact',
  'artifact-versions': 'content.artifact_version',
  'artifact-relationships': 'content.artifact_relationship',
  'external-identifiers': 'content.external_locator',
};

/**
 * Order matters on the way back in: a row cannot reference a row that does not exist yet.
 * Objects before everything, people before role assignments, actions before audit events.
 */
const IMPORT_ORDER = [
  'objects',
  'organizations',
  'people',
  'engagements',
  'role-assignments',
  'actions',
  'relations',
  'approvals',
  'snapshots',
  'audit-events',
  'audit-checkpoints',
  'artifacts',
  'artifact-versions',
  'artifact-relationships',
  'external-identifiers',
] as const;

type Row = Record<string, unknown>;

/**
 * Normalize a database row into something canonicalizable and stable.
 *
 * Dates become ISO strings and bigints become decimal strings, because a value that
 * round-trips through the export as a different JavaScript type would compare unequal on
 * re-export while representing exactly the same fact.
 */
function normalize(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) {
    const v = row[key];
    if (v instanceof Date) out[key] = v.toISOString();
    else if (typeof v === 'bigint') out[key] = v.toString();
    else if (Buffer.isBuffer(v)) out[key] = v.toString('base64');
    else out[key] = v;
  }
  return out;
}

function file(path: string, value: unknown): ExportFile {
  return { path, content: `${canonicalize(value)}\n` };
}

export async function createExport(tx: Tx): Promise<ExportPackage> {
  const release = await tx.one<{ version: string; ontology_digest: string }>(
    'select version, ontology_digest from registry.schema_release where is_current',
  );

  const files: ExportFile[] = [];
  const counts: Record<string, number> = {};

  // The ontology travels WITH the data. Without it, a reader in twenty years has rows whose
  // state and action tokens mean nothing.
  const ontology = {
    object_types: await tx.query('select * from registry.object_type order by id'),
    relation_types: await tx.query('select * from registry.relation_type order by id'),
    action_types: await tx.query('select * from registry.action_type order by id'),
    state_machines: await tx.query('select * from registry.state_machine order by id'),
    object_states: await tx.query(
      'select * from registry.object_state order by object_type, state',
    ),
    state_transitions: await tx.query(
      'select * from registry.state_transition order by object_type, from_state, to_state, action_id',
    ),
    rules: await tx.query('select * from registry.rule_definition order by id'),
    classifications: await tx.query('select * from registry.classification order by rank'),
    retention_classes: await tx.query('select * from registry.retention_class order by id'),
  };
  files.push(file('ontology/registry.json', ontology));

  for (const section of SECTIONS) {
    const rows = (await tx.query(section.sql)).map(normalize);
    counts[section.name] = rows.length;
    files.push(file(`${section.name}.json`, rows));
  }

  const auditRange = await tx.one<{ from_seq: string | null; to_seq: string | null }>(
    'select min(seq) as from_seq, max(seq) as to_seq from core.audit_event',
  );

  files.sort((a, b) => a.path.localeCompare(b.path));

  const manifest: ExportManifest = {
    format_version: EXPORT_FORMAT_VERSION,
    ontology_version: release.version,
    ontology_digest: release.ontology_digest,
    schema_version: release.version,
    audit_from_seq: auditRange.from_seq === null ? null : Number(auditRange.from_seq),
    audit_to_seq: auditRange.to_seq === null ? null : Number(auditRange.to_seq),
    counts,
    // The manifest does NOT list itself: a file cannot contain its own hash. Verifying the
    // manifest is a separate act — signing it.
    files: files.map((f) => {
      const bytes = Buffer.from(f.content, 'utf8');
      return { path: f.path, size_bytes: bytes.length, sha256: digestBytes(bytes) };
    }),
  };

  return {
    files: [...files, { path: 'manifest.json', content: `${canonicalize(manifest)}\n` }],
    manifest,
  };
}

export interface VerificationFinding {
  readonly path: string;
  readonly problem: 'missing' | 'size_mismatch' | 'digest_mismatch' | 'unlisted';
  readonly detail: string;
}

/** Check an export against its own manifest. */
export function verifyExport(pkg: ExportPackage): VerificationFinding[] {
  const byPath = new Map(pkg.files.map((f) => [f.path, f]));
  const findings: VerificationFinding[] = [];

  for (const entry of pkg.manifest.files) {
    const f = byPath.get(entry.path);
    if (f === undefined) {
      findings.push({ path: entry.path, problem: 'missing', detail: 'listed but absent' });
      continue;
    }
    const bytes = Buffer.from(f.content, 'utf8');
    if (bytes.length !== entry.size_bytes) {
      findings.push({
        path: entry.path,
        problem: 'size_mismatch',
        detail: `manifest says ${entry.size_bytes}, file is ${bytes.length}`,
      });
    }
    const actual = digestBytes(bytes);
    if (actual !== entry.sha256) {
      findings.push({
        path: entry.path,
        problem: 'digest_mismatch',
        detail: `manifest says ${entry.sha256}, file hashes to ${actual}`,
      });
    }
  }

  // A file present but unlisted is as much a problem as one listed and absent: it is
  // content nobody vouched for.
  const listed = new Set(pkg.manifest.files.map((f) => f.path));
  for (const f of pkg.files) {
    if (f.path !== 'manifest.json' && !listed.has(f.path)) {
      findings.push({ path: f.path, problem: 'unlisted', detail: 'present but not in manifest' });
    }
  }
  return findings;
}

/** Semantic identity of an export: the digest of its manifest minus the file list. */
export function exportIdentity(manifest: ExportManifest): string {
  const { files: _files, ...rest } = manifest;
  return digestOf(rest);
}

interface TableColumns {
  /** Every column the table has. An import may write no others. */
  readonly all: ReadonlySet<string>;
  /** The json/jsonb subset, which must be passed as text rather than as a JS value. */
  readonly json: ReadonlySet<string>;
}

/**
 * A table's columns, read from the catalogue rather than hard-coded.
 *
 * This is the ALLOW-LIST for import, not merely a type hint. Column names in an export file
 * are attacker-controllable — a package's manifest verifies the digests of its files as they
 * are, so whoever crafts the package computes those digests too — and they are interpolated
 * into the INSERT text because SQL has no parameter form for an identifier. Checking each one
 * against the real table is what closes that.
 */
async function tableColumns(tx: Tx, qualified: string): Promise<TableColumns> {
  const [schema, table] = qualified.split('.');
  const rows = await tx.query<{ column_name: string; data_type: string }>(
    `select column_name, data_type from information_schema.columns
      where table_schema = $1 and table_name = $2`,
    [schema, table],
  );
  if (rows.length === 0) throw new Error(`no such table: ${qualified}`);
  return {
    all: new Set(rows.map((r) => r.column_name)),
    json: new Set(
      rows
        .filter((r) => r.data_type === 'json' || r.data_type === 'jsonb')
        .map((r) => r.column_name),
    ),
  };
}

function sectionRows(pkg: ExportPackage, name: string): Row[] {
  const f = pkg.files.find((x) => x.path === `${name}.json`);
  if (f === undefined) throw new Error(`export has no ${name}.json`);
  return JSON.parse(f.content) as Row[];
}

/**
 * Import an export into an EMPTY database whose migrations have already run.
 *
 * Write guards and triggers are suspended for the duration — deliberately, and only here.
 * An import is not a series of new actions; it is the restoration of actions that already
 * happened, and re-running them through the dispatcher would invent new identities, new
 * timestamps and a new audit chain, destroying the very history being restored.
 *
 * `session_replication_role = replica` is PostgreSQL's own mechanism for exactly this: it
 * is what pg_restore uses, and it disables user triggers and FK checks for the session
 * without weakening anything permanently.
 */
export async function importExport(tx: Tx, pkg: ExportPackage): Promise<{ imported: number }> {
  const findings = verifyExport(pkg);
  if (findings.length > 0) {
    // Refuse rather than import partially verified data. A restore is exactly when you
    // cannot afford to discover the package was damaged.
    throw new Error(
      `refusing to import an export that fails its own manifest: ${findings
        .map((f) => `${f.path} ${f.problem}`)
        .join(', ')}`,
    );
  }

  await tx.query("set local session_replication_role = 'replica'");

  let imported = 0;
  for (const name of IMPORT_ORDER) {
    const table = IMPORT_TARGETS[name];
    if (table === undefined) continue;
    const rows = sectionRows(pkg, name);
    if (rows.length === 0) continue;

    const columnsOf = await tableColumns(tx, table);

    // One shape per section: rows within a section come from a single SELECT, so they all
    // carry the same keys. A row that does not is a malformed package, not a variation.
    const columns = Object.keys(rows[0]!);
    for (const c of columns) {
      if (!columnsOf.all.has(c)) {
        throw new Error(
          `refusing to import: ${name}.json names a column '${c}' that ${table} does not have`,
        );
      }
    }
    for (const [i, row] of rows.entries()) {
      const keys = Object.keys(row);
      if (keys.length !== columns.length || keys.some((k, j) => k !== columns[j])) {
        throw new Error(`refusing to import: ${name}.json row ${i} has a different column set`);
      }
    }

    const prepare = (row: Row): unknown[] =>
      columns.map((c) => {
        const v = row[c];
        // json/jsonb values must arrive as text. The driver renders a JavaScript ARRAY as a
        // PostgreSQL array literal — correct for `uuid[]`, invalid JSON for `jsonb` — so a
        // jsonb column holding a list would fail on restore, and only on restore.
        return columnsOf.json.has(c) && v !== null ? JSON.stringify(v) : v;
      });

    // Batched, because a restore runs as ONE transaction and a row-at-a-time loop over a
    // large audit log is that many round trips holding locks — long enough to trip
    // idle_in_transaction_session_timeout on the database you are trying to rescue.
    const perStatement = Math.max(1, Math.floor(MAX_BIND_PARAMETERS / columns.length));
    for (let start = 0; start < rows.length; start += perStatement) {
      const batch = rows.slice(start, start + perStatement);
      const values: unknown[] = [];
      const tuples = batch.map((row) => {
        const placeholders = columns.map((_, i) => `$${values.length + i + 1}`).join(', ');
        values.push(...prepare(row));
        return `(${placeholders})`;
      });
      await tx.query(
        `insert into ${table} (${columns.join(', ')}) values ${tuples.join(', ')}`,
        values,
      );
      imported += batch.length;
    }
  }

  // Re-align the one sequence in the schema. Resolved from the catalogue rather than spelled
  // out, so renaming the column or the table cannot leave this silently pointing at nothing.
  // Every other identifier is a `uuid default uuidv7()` and needs no realignment.
  await tx.query(
    `select setval(pg_get_serial_sequence('core.audit_event', 'seq'),
                   coalesce((select max(seq) from core.audit_event), 1), true)`,
  );

  return { imported };
}

export const PACKAGE = {
  name: '@kf/export',
  role: 'Preservation export and round-trip',
  owns: [],
} as const;
