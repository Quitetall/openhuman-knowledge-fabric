-- migrate:up

-- A compilation whose sources and pinned compiler have been shown not to reproduce is not
-- accepted (KF-SAS-RQ-102; closes the acceptance clause of SAS §100.35).
--
-- 20260925160100 refuses to record, as a success, a compilation that does not reproduce an
-- earlier succeeded run over the same source identity; the worker records it instead as the
-- request's failed run, `failure_code = 'nondeterministic_output'`, naming the run it did not
-- reproduce. Nothing read that record at acceptance, so `accept_document_compilation` still took
-- any succeeded run of those sources.
--
-- WHICH RUNS. Every succeeded run of one source identity carries the same output — the
-- reproduction trigger refuses any that differs from an earlier one — so a failed reproduction is
-- a failure to reproduce each of them, not only the run its message names: the pinned binary,
-- given these exact sources, produced something else. Acceptance is therefore refused for every
-- succeeded run whose source identity (`content.compilation_source_identity`) has a recorded
-- `nondeterministic_output` run, earlier or later. The earlier run is in practice also refused
-- because its registration was revoked to requalify the binary (KF-DOC-COMPILE-004); the case
-- this closes is the later requalification that happens to reproduce the first output, which
-- was acceptable. A new compiler binary is a new source identity and is not affected.
--
-- WHERE. The dispatcher precondition refuses with KF-DOC-DETERMINISM-002 before anything is
-- written; the trigger on the acceptance row is the authority, because it holds whatever the
-- precondition was given. `publish_document_view` needs this acceptance row, so nothing further
-- is needed there. Restore runs with triggers off and keeps an acceptance recorded before this.
--
-- No new table: the fact is the failed run 20260925160100 already records.

create function content.compilation_reproduction_failure(p_run uuid) returns uuid
language sql
stable
security definer
set search_path = pg_catalog, content, core
as $$
  select failed.id
    from content.compilation_run run
    join content.compilation_basis basis on basis.id = run.basis_id
    join content.composition_revision composition
      on composition.id = basis.root_composition_revision_id
    join content.document_subject subject on subject.id = composition.composition_id
    join core.object object on object.id = subject.object_id
    join content.compilation_basis failed_basis
      on failed_basis.root_composition_revision_id = basis.root_composition_revision_id
    join content.compilation_run failed
      on failed.basis_id = failed_basis.id
     and failed.id <> run.id
     and failed.run_status = 'failed'
     and failed.failure_code = 'nondeterministic_output'
   where run.id = p_run
     and run.run_status = 'succeeded'
     and object.organization_id = (select core.current_organization())
     and content.compilation_source_identity(failed_basis.basis)
         = content.compilation_source_identity(basis.basis)
   order by failed.recorded_at, failed.id
   limit 1
$$;

comment on function content.compilation_reproduction_failure(uuid) is
  'KF-SAS-RQ-102: the earliest nondeterministic_output run over the same sources and pinned '
  'compiler as this succeeded run, in the bound organization; null when none was recorded.';

create function content.refuse_unreproduced_acceptance() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content, core
as $$
declare
  v_run text := new.parameters ->> 'run_id';
  v_failed uuid;
begin
  if v_run is null
     or v_run !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return new;
  end if;
  v_failed := content.compilation_reproduction_failure(v_run::uuid);
  if v_failed is not null then
    raise exception
      'KF-DOC-DETERMINISM-002: compilation run % cannot be accepted: run % over the same sources '
      'and pinned compiler did not reproduce it (KF-SAS-RQ-102)', v_run, v_failed
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger action_accepts_only_reproduced_compilation
  before insert on core.action
  for each row
  when (new.action_type = 'accept_document_compilation' and new.result_status = 'applied')
  execute function content.refuse_unreproduced_acceptance();

revoke all on function content.compilation_reproduction_failure(uuid) from public;
revoke all on function content.refuse_unreproduced_acceptance() from public;
grant execute on function content.compilation_reproduction_failure(uuid) to kf_app;

-- migrate:down

drop trigger action_accepts_only_reproduced_compilation on core.action;
drop function content.refuse_unreproduced_acceptance();
drop function content.compilation_reproduction_failure(uuid);
