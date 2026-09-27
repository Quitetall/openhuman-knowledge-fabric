-- migrate:up

-- A compilation of the same sources by the same pinned compiler reproduces the earlier one, or
-- it is not recorded as a success (KF-SAS-RQ-102, ADR 0002 note of 2026-09-25).
--
-- RQ-102 says compilation SHALL be deterministic for a given source and toolchain. Nothing
-- compared two compilations, so a nondeterministic compiler was indistinguishable from a
-- deterministic one. The exact case could not arise — `compilation_basis.basis_digest` is unique
-- and `record_compilation_result` refuses a re-record that differs — but a Basis also carries
-- `compiler.qualification`, a governance fact about the binary rather than part of what it
-- computes. Revoking a registration and registering the same pinned binary with a new
-- qualification makes a new Basis over the same sources and the same binary; its run was never
-- compared with the first.
--
-- THE KEY. Two Bases are "the same source and toolchain" when their canonical JSON is equal
-- after removing `compiler.qualification` and `basisDigest` (the digest over the rest). jsonb
-- equality is semantic, so key order is not a difference. Everything else — every fragment,
-- composition and binding revision with its content digest, the target profiles, the ontology
-- and policy digests, the compiler's name, version, commit, Cargo.lock, executable and runtime
-- closure — must match.
--
-- THE OUTPUT. The semantic digest and the set of (target, content digest) of the compiled views.
--
-- WHEN. A deferred constraint trigger, so the views `record_compilation_result` inserts after
-- the run are in place when it fires at commit. SECURITY DEFINER because a deferred trigger
-- fires as the session's login, outside the definer seam that inserted the row.
--
-- NOT DONE HERE: running the compiler again to test determinism (this checks every reproduction
-- that happens and causes none), and refusing to ACCEPT an earlier run that a later one failed to
-- reproduce — the failure is recorded as a failed run naming it, and nothing yet reads that at
-- acceptance.

create index if not exists compilation_basis_root_revision
  on content.compilation_basis (root_composition_revision_id);
create index if not exists compilation_run_basis
  on content.compilation_run (basis_id);

create function content.compilation_source_identity(p_basis jsonb) returns jsonb
language sql
immutable
set search_path = pg_catalog
as $$
  select (p_basis #- '{compiler,qualification}') - 'basisDigest'
$$;

comment on function content.compilation_source_identity(jsonb) is
  'KF-SAS-RQ-102: the part of a Basis that determines a compilation''s output — everything but '
  'the compiler''s qualification and the digest over the whole.';

-- The earliest succeeded run of the same source identity whose output differs from p_run's, or
-- null (always null for a run that did not succeed).
create function content.compilation_reproduction_conflict(p_run uuid) returns uuid
language sql
stable
security definer
set search_path = pg_catalog, content
as $$
  with this as (
    select r.id,
           r.run_status,
           r.semantic_digest,
           b.root_composition_revision_id,
           content.compilation_source_identity(b.basis) as sources,
           coalesce((select jsonb_agg(jsonb_build_array(v.target, v.content_digest)
                                      order by v.target)
                       from content.compiled_view v
                      where v.compilation_run_id = r.id), '[]'::jsonb) as views
      from content.compilation_run r
      join content.compilation_basis b on b.id = r.basis_id
     where r.id = p_run
  )
  select other.id
    from this
    join content.compilation_basis other_basis
      on other_basis.root_composition_revision_id = this.root_composition_revision_id
    join content.compilation_run other
      on other.basis_id = other_basis.id
     and other.id <> this.id
     and other.run_status = 'succeeded'
   where this.run_status = 'succeeded'
     and content.compilation_source_identity(other_basis.basis) = this.sources
     and (other.semantic_digest is distinct from this.semantic_digest
          or coalesce((select jsonb_agg(jsonb_build_array(v.target, v.content_digest)
                                        order by v.target)
                         from content.compiled_view v
                        where v.compilation_run_id = other.id), '[]'::jsonb)
             <> this.views)
   order by other.recorded_at, other.id
   limit 1
$$;

comment on function content.compilation_reproduction_conflict(uuid) is
  'KF-SAS-RQ-102: the earliest succeeded run of the same sources and pinned compiler whose '
  'semantic digest or view digests differ from this run''s; null when it reproduces them all.';

create function content.refuse_unreproduced_compilation() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content
as $$
declare
  v_other uuid;
begin
  v_other := content.compilation_reproduction_conflict(new.id);
  if v_other is not null then
    raise exception
      'KF-DOC-DETERMINISM-001: compilation run % does not reproduce run %, compiled from the '
      'same sources by the same pinned compiler (KF-SAS-RQ-102)', new.id, v_other
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end
$$;

create constraint trigger compilation_run_reproduces
  after insert on content.compilation_run
  deferrable initially deferred
  for each row
  when (new.run_status = 'succeeded')
  execute function content.refuse_unreproduced_compilation();

revoke all on function content.compilation_source_identity(jsonb) from public;
revoke all on function content.compilation_reproduction_conflict(uuid) from public;
revoke all on function content.refuse_unreproduced_compilation() from public;
grant execute on function content.compilation_source_identity(jsonb) to kf_app, kf_worker;
grant execute on function content.compilation_reproduction_conflict(uuid) to kf_worker;

-- migrate:down

drop trigger compilation_run_reproduces on content.compilation_run;
drop function content.refuse_unreproduced_compilation();
drop function content.compilation_reproduction_conflict(uuid);
drop function content.compilation_source_identity(jsonb);
drop index if exists content.compilation_run_basis;
drop index if exists content.compilation_basis_root_revision;
