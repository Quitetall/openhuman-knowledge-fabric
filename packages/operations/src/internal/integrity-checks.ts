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
  const row = await tx.one<{ breaks: string; total: string }>(
    `with linked as (
       select seq, prev_digest,
              lag(digest) over (order by seq) as expected_prev
         from core.audit_event
     )
     select count(*) filter (
              where (expected_prev is null and prev_digest <> repeat('0', 64))
                 or (expected_prev is not null and prev_digest <> expected_prev)
            )::text as breaks,
            count(*)::text as total
       from linked`,
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
  const row = await tx.one<{ uncovered: string; checkpoints: string; last_at: Date | null }>(
    `select (select count(*) from core.audit_event e
              where not exists (
                select 1 from core.audit_checkpoint c
                 where e.seq between c.from_seq and c.to_seq))::text as uncovered,
            (select count(*) from core.audit_checkpoint)::text as checkpoints,
            (select max(recorded_at) from core.audit_checkpoint) as last_at`,
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
      lastSignedAt: row.last_at === null ? null : row.last_at.toISOString(),
    },
  };
};
