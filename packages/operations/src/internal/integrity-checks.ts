import type { CheckFn } from './contracts.js';

export const schemaRelease: CheckFn = async (tx) => {
  const row = await tx.maybeOne<{ version: string; ontology_digest: string }>(
    'select version, ontology_digest from registry.schema_release where is_current',
  );
  if (row === undefined) {
    return {
      id: 'schema_release',
      status: 'failed',
      detail: 'No current schema release. The ontology seed has not been applied.',
    };
  }
  return {
    id: 'schema_release',
    status: 'ok',
    detail: `Schema release ${row.version} is current.`,
    measured: { version: row.version, ontologyDigest: row.ontology_digest.slice(0, 12) },
  };
};

export const writeGuardsPresent: CheckFn = async (tx) => {
  const row = await tx.one<{ guards: string }>(
    `select count(*)::text as guards from pg_trigger
      where tgname in ('object_guard_1_context', 'object_guard_2_transition',
                       'object_guard_3_row_version')
        and not tgisinternal`,
  );
  const guards = Number(row.guards);
  return {
    id: 'write_guards',
    status: guards === 3 ? 'ok' : 'failed',
    detail:
      guards === 3
        ? 'All three write guards are installed.'
        : `Only ${guards} of 3 write guards are installed. Controlled records can be changed without an action.`,
    measured: { guards },
  };
};

export const chainIntact: CheckFn = async (tx) => {
  // The audit log is cluster-global, while ordinary audit reads are scoped to visible objects.
  // Ask the narrow database aggregate so an absent organization context cannot turn hidden
  // events into a false green chain check or expose the event rows themselves.
  const row = await tx.one<{ breaks: string; total: string }>(
    `select breaks::text, total::text
       from core.readiness_audit_chain()`,
  );
  const breaks = Number(row.breaks);
  return {
    id: 'audit_chain',
    status: breaks === 0 ? 'ok' : 'failed',
    detail:
      breaks === 0
        ? 'Every audit event links to its predecessor.'
        : `${breaks} audit event(s) do not link. The record has been altered, or a write bypassed the dispatcher.`,
    measured: { events: Number(row.total), breaks },
  };
};

export const checkpointCoverage: CheckFn = async (tx, limits) => {
  // Checkpoints are cluster-global and intentionally not directly readable by kf_app. Ask the
  // narrow database aggregate instead of granting the readiness process the signed rows or
  // allowing a missing context to turn an absent checkpoint into a false green.
  const row = await tx.one<{ uncovered: string; checkpoints: string; last_signed_at: Date | null }>(
    `select uncovered::text, checkpoints::text, last_signed_at
       from core.readiness_checkpoint_coverage()`,
  );
  const uncovered = Number(row.uncovered);
  const checkpoints = Number(row.checkpoints);

  if (checkpoints === 0) {
    return {
      id: 'checkpoint_coverage',
      status: 'failed',
      detail:
        'No audit checkpoint has ever been signed. A rewrite of the whole log would be undetectable to anyone without an older copy.',
      measured: { checkpoints: 0, uncovered },
    };
  }
  return {
    id: 'checkpoint_coverage',
    status:
      uncovered === 0 ? 'ok' : uncovered <= limits.uncheckpointedEvents ? 'degraded' : 'failed',
    detail:
      uncovered === 0
        ? 'Every audit event sits inside a signed checkpoint.'
        : `${uncovered} audit event(s) are outside any signed checkpoint; a rewrite of them would not be detectable by signature.`,
    measured: {
      uncovered,
      checkpoints,
      lastSignedAt: row.last_signed_at === null ? null : row.last_signed_at.toISOString(),
    },
  };
};
