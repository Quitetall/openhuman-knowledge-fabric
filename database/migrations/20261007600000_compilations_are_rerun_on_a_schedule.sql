-- migrate:up

-- A compilation is re-run on a schedule to test that the compiler is deterministic (SAS §100.35,
-- KF-SAS-RQ-102).
--
-- 20260925160100 refuses a success that does not reproduce an earlier run over the same sources
-- by the same pinned compiler, but only when something happens to compile those sources again. A
-- nondeterministic compiler nobody re-ran was never caught. `kf-compiler-determinism.timer` now
-- re-runs recorded successes, read-only: it compiles each one's Basis again with the same run
-- identity and compares the run digest it gets with the one recorded, and records nothing.
--
-- The worker's login cannot read `content.compilation_run` (it inserts receipts and reads its
-- own request through `content.compiler_runtime_request`). This function is the one read it
-- needs: the request acts of the newest succeeded runs whose compiler registration is still
-- enabled — a revoked registration's request is refused by `compiler_runtime_request`, and its
-- binary is not the one installed. It returns act identifiers only; everything the re-run reads
-- comes through `compiler_runtime_request`, as the worker's own compilations do.

create function content.compilation_determinism_sample(p_limit integer)
returns table (request_action_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, content
as $$
  select r.requested_by_action
    from content.compilation_run r
    join content.compilation_basis b on b.id = r.basis_id
   where r.run_status = 'succeeded'
     and not exists (
       select 1 from content.document_compiler_revocation revoked
        where revoked.registration_id = b.compiler_registration_id
     )
   order by r.recorded_at desc, r.id
   limit greatest(1, least(coalesce(p_limit, 1), 100))
$$;

comment on function content.compilation_determinism_sample(integer) is
  'SAS §100.35: the request acts of the newest succeeded compilation runs (1 to 100) whose '
  'compiler registration is enabled, for the scheduled read-only determinism re-run.';

revoke all on function content.compilation_determinism_sample(integer) from public;
grant execute on function content.compilation_determinism_sample(integer) to kf_worker;

-- migrate:down

drop function content.compilation_determinism_sample(integer);
