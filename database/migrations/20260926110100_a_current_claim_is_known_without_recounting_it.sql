-- migrate:up

-- A current master record is known without enumerating its corpus again (ADR 0013, ADR 0033,
-- KF-SAS-RQ-112).
--
-- THE COST, MEASURED. `GET /objects/:id` reads over the viewer's master record and answers
-- `409 master_record_stale` when the corpus has moved since it was compiled. "Moved" was decided
-- the only way it could be: enumerate the whole permitted set again, with every member's payload,
-- digest each member, and compare. On the kf-fixa fixture (2026-09-26) a reader of Redwood
-- Inference's ~50 000 records waited 12-16 s for that answer on every view, 94 % of it in the
-- enumeration: 142 MB of payload JSON built by `content.master_record_payloads` (7.3 s as the
-- owner, before row security), shipped to the API and digested there. Reading one record cost
-- reading all of them.
--
-- WHAT IS RECORDED INSTEAD. Nothing about the answer changes; what changes is how it is known.
-- A compilation reads the corpus in one transaction, and the database can say, afterwards,
-- whether ANY transaction has written ANY input of that reading since:
--
--   content.master_record_input_write   one row per writing transaction and organization, written
--       by a statement-level trigger on every table in the schemas the permitted set is read from
--       (the envelope, every typed and referencing table the payload walks, grants, role
--       assignments, exclusions, holds, the classification registry), except the tables named in
--       content.master_record_input_exemption, each with its reason. The organization is the one
--       the writer's sealed context is bound to — row security confines a bound writer to its own
--       organization — and null for an administrator session or an unbound one, which counts as
--       a write to every organization.
--
--   content.master_record_currency      one row per compilation a person makes of their OWN
--       record: the claim it produced or reused, the snapshot taken before the compilation read
--       anything, the context it read under (organization, acting role, classification rank),
--       a fingerprint of the catalog the reading depends on, and the first moment a grant or
--       role assignment reaching this organization starts or stops being in force.
--
-- `content.master_record_current_format(claim)` answers whether the claim is current without
-- reading the corpus: a currency row for it under the caller's own context, unexpired, whose
-- validity boundary has not passed, whose catalog fingerprint is today's, and no write to an
-- input — in the caller's organization or in all of them — by a transaction that the recorded
-- snapshot did not see. If all of that holds, the corpus the compilation read is the corpus the
-- caller would read now, so the claim's comparison with it (which the compilation made, and which
-- produced or reused this claim) still stands. If any of it fails, the caller falls back to the
-- enumeration, exactly as before. The shortcut can only ever say "current" when nothing it depends
-- on has been written; it can say "unknown" far more often than "stale" would be true, and that is
-- the price of it being sound.
--
-- WHY A SNAPSHOT AND NOT A TIMESTAMP. Transactions commit out of the order they started in. A write
-- that began before the compilation and committed after it is invisible to the compilation's reads
-- yet timestamped earlier. `pg_visible_in_snapshot(xact, snapshot)` asks the question that matters:
-- did the compilation's reading see this writer?
--
-- BOTH TABLES ARE TRANSIENT (§64B). A currency row is an observation about a claim, not a record;
-- after a restore its snapshot names transactions of another server, so it must not survive one:
-- excluded from the export and from backup data, and swept. The sweep keeps every write row a live
-- currency row still needs (anything at or after the oldest live snapshot's xmin), so expiry can
-- never make a stale claim look current. A catalog fingerprint that changes with any DDL on the
-- governed schemas also retires every currency row when a migration changes what a reading means.

-- Tables whose writes do NOT change what a permitted-set enumeration reads, each with its reason.
-- tests/database/master-record-currency.test.ts pins this list and proves that no row-security
-- policy of a table that IS read, and no function such a policy calls, depends on any of these.
create table content.master_record_input_exemption (
  table_name text primary key,
  reason     text not null check (length(btrim(reason)) >= 40)
);

comment on table content.master_record_input_exemption is
  'Tables in the governed schemas whose writes are not inputs of a master-record permitted set, '
  'so they carry no zz_master_record_input_written trigger. Each with its reason; pinned by '
  'tests/database/master-record-currency.test.ts.';

revoke all on content.master_record_input_exemption from public;
grant select on content.master_record_input_exemption to kf_backup;

insert into content.master_record_input_exemption (table_name, reason) values
  ('core.action',
   'The act ledger. Every act appends to it; no permitted-set read, payload or policy of an input table reads it.'),
  ('core.action_migration019_legacy',
   'Historical ledger rows kept by migration 019; read by nothing that decides a permitted set.'),
  ('core.approval',
   'Approval bookkeeping of acts; not an input of the envelope, payload, grant or exclusion reads.'),
  ('core.audit_chain_head',
   'The head of the audit chain, written by every act; not read by any permitted-set input.'),
  ('core.audit_checkpoint',
   'Signed checkpoints of the audit chain; not read by any permitted-set input.'),
  ('core.audit_event',
   'The audit chain, appended by every act; not read by any permitted-set input or its policies.'),
  ('core.context_seal_key',
   'The key that seals the session context; binding reads it, a permitted-set enumeration does not.'),
  ('core.migration030_rollback_state',
   'Migration bookkeeping for 030; read by nothing that decides a permitted set.'),
  ('core.object_verification',
   'Verification is read live on every view and is not part of a member digest or of the corpus.'),
  ('core.outbox',
   'Delivery queue of enqueued work; the work it runs writes inputs itself, which is what is noted.'),
  ('core.principal_attestation',
   'Sixty-second attestation proofs; the context they bind is compared directly, not through here.'),
  ('core.relation',
   'The relation graph is read live for sections and neighbourhoods and is not part of the corpus.'),
  ('core.snapshot',
   'Point-in-time snapshot bookkeeping; not an input of the envelope, payload or grant reads.'),
  ('core.write_guard_exemption',
   'Static list of write-guard exemptions; read by the guard installer, not by any permitted set.'),
  ('content.master_record',
   'The claims themselves: a claim is compared with its inputs, it is not one of them.'),
  ('content.master_record_item',
   'Members of a claim, written with the claim; the payload walk excludes every master_record table.'),
  ('content.master_record_withholding',
   'The withholding ledger of a claim, written with it; excluded from the payload walk by name.'),
  ('content.master_record_link',
   'Share links to a claim; excluded from the payload walk by name and read by no input policy.'),
  ('content.master_record_link_revocation',
   'Revocations of share links; excluded from the payload walk by name, read by no input policy.'),
  ('content.master_record_delivery_receipt',
   'Delivery receipts of shared claims; excluded from the payload walk by name, read by no input.'),
  ('content.master_record_link_access',
   'The access log of a share-link bearer; excluded from the payload walk by name, read by no input.'),
  ('content.master_record_currency',
   'This table: observations that a claim was current, written by compilations, never an input.'),
  ('content.master_record_input_write',
   'This table: the log of input writes itself, written by the trigger that notes them.'),
  ('content.master_record_input_exemption',
   'This table: the static list of exemptions, changed only by migrations, never an input.'),
  ('registry.identifier_allocation',
   'Identifier allocations, appended by allocation acts; no permitted-set input reads them.'),
  ('registry.identifier_sequence',
   'The next value of each identifier namespace, bumped by every allocation; read by no input.');

create table content.master_record_input_write (
  xact            xid8 not null default pg_current_xact_id(),
  organization_id uuid,
  written_at      timestamptz not null default clock_timestamp(),
  expires_at      timestamptz not null default now() + interval '30 days'
);

-- Once per transaction and organization: a transaction that writes ten thousand rows is one fact.
create unique index master_record_input_write_once
  on content.master_record_input_write (xact, organization_id) nulls not distinct;
create index master_record_input_write_by_organization
  on content.master_record_input_write (organization_id, xact);

comment on table content.master_record_input_write is
  'Transient (§64B): which transactions wrote an input of a master-record permitted set, and for '
  'which organization (null: every organization). Read only through '
  'content.master_record_current_format; swept, keeping what a live currency row still needs.';

alter table content.master_record_input_write enable row level security;
alter table content.master_record_input_write force row level security;
-- No policy: no application role reads or writes it except through the definer functions below.
revoke all on content.master_record_input_write from public;
grant maintain on content.master_record_input_write to kf_backup;

create table content.master_record_currency (
  id                  uuid primary key default uuidv7(),
  master_record_id    uuid not null references content.master_record (id) on delete restrict,
  organization_id     uuid not null,
  acting_role_id      uuid not null,
  classification_rank integer not null,
  manifest_format     text not null,
  snapshot            pg_snapshot not null,
  schema_fingerprint  text not null check (schema_fingerprint ~ '^[0-9a-f]{64}$'),
  valid_until         timestamptz,
  recorded_by_action  uuid not null,
  recorded_at         timestamptz not null default now(),
  expires_at          timestamptz not null default now() + interval '7 days',
  check (expires_at > recorded_at),
  check (valid_until is null or valid_until > recorded_at)
);

create index master_record_currency_by_claim
  on content.master_record_currency (master_record_id, recorded_at desc);
create index master_record_currency_expiry on content.master_record_currency (expires_at);

comment on table content.master_record_currency is
  'Transient (§64B): a compilation of a person''s own master record found this claim current as '
  'of this snapshot, under this context. content.master_record_current_format reads it; expires '
  'after 7 days, after which a view falls back to enumerating the corpus.';

alter table content.master_record_currency enable row level security;
alter table content.master_record_currency force row level security;

-- Readable by the bound person whose claim it is, in its organization: it says when they compiled.
create policy master_record_currency_read on content.master_record_currency for select
  using (
    organization_id = (select core.current_organization())
    and exists (
      select 1 from content.master_record master
       where master.id = master_record_currency.master_record_id
         and master.person_id = (select core.sealed_setting('kf.principal', true))::uuid
    )
  );

revoke all on content.master_record_currency from public;
grant select on content.master_record_currency to kf_app;
grant maintain on content.master_record_currency to kf_backup;

-- Note one write of an input. Statement-level and idempotent per transaction and organization.
create function content.note_master_record_input_write() returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  insert into content.master_record_input_write (organization_id)
  values (case when core.session_is_administrator() then null
               else core.current_organization() end)
  on conflict do nothing;
  return null;
end
$$;

revoke all on function content.note_master_record_input_write() from public;

-- Attach the note to every table in the governed schemas that is not exempt. Idempotent, so a
-- later migration that adds a table calls it again (tests/database/master-record-currency.test.ts
-- refuses a table that has neither the trigger nor an exemption).
create function content.install_master_record_input_triggers() returns integer
language plpgsql
set search_path = pg_catalog
as $$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    select format('%I.%I', n.nspname, c.relname) as tbl
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind in ('r', 'p')
       and n.nspname in ('content', 'core', 'engineering', 'finance', 'ml', 'org', 'product',
                         'quality', 'registry', 'secure_object', 'work')
       and not exists (
         select 1 from content.master_record_input_exemption e
          where e.table_name = format('%I.%I', n.nspname, c.relname))
     order by 1
  loop
    execute format('drop trigger if exists zz_master_record_input_written on %s', r.tbl);
    execute format(
      'create trigger zz_master_record_input_written '
      'after insert or update or delete or truncate on %s '
      'for each statement execute function content.note_master_record_input_write()', r.tbl);
    v_count := v_count + 1;
  end loop;
  return v_count;
end
$$;

revoke all on function content.install_master_record_input_triggers() from public;

select content.install_master_record_input_triggers();

-- The catalog a permitted-set reading depends on: relations, constraints (the payload walk follows
-- foreign keys), functions and triggers in the governed schemas, and every row-security policy.
-- Any DDL rewrites a catalog row, and so its xmin; a restore recreates them all.
create function content.master_record_schema_fingerprint() returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  with governed(oid) as (
    select oid from pg_namespace
     where nspname in ('content', 'core', 'engineering', 'finance', 'ml', 'org', 'product',
                       'quality', 'registry', 'secure_object', 'work')
  )
  select encode(sha256(convert_to(coalesce(string_agg(entry, E'\n' order by entry), ''), 'UTF8')), 'hex')
    from (
      select 'class ' || c.oid::text || ' ' || format('%s', c.xmin)
        from pg_class c where c.relnamespace in (select oid from governed)
      union all
      select 'constraint ' || k.oid::text || ' ' || format('%s', k.xmin)
        from pg_constraint k where k.connamespace in (select oid from governed)
      union all
      select 'function ' || f.oid::text || ' ' || format('%s', f.xmin)
        from pg_proc f where f.pronamespace in (select oid from governed)
      union all
      select 'trigger ' || t.oid::text || ' ' || format('%s', t.xmin)
        from pg_trigger t join pg_class c on c.oid = t.tgrelid
       where c.relnamespace in (select oid from governed)
      union all
      select 'policy ' || p.oid::text || ' ' || format('%s', p.xmin) from pg_policy p
    ) as catalog(entry)
$$;

revoke all on function content.master_record_schema_fingerprint() from public;

-- The first moment after now() at which a grant, role assignment or project membership reaching
-- this organization, or a role assignment of this person, starts or stops being in force: the
-- permitted set can change then with nothing written. Deliberately wider than the person's own
-- coverage (a boundary of somebody else's grant only shortens the shortcut, never lengthens it).
create function content.master_record_currency_boundary(p_person uuid, p_organization uuid)
returns timestamptz
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select min(boundary) from (
    select g.valid_from from org.effective_access_grant g
     where g.organization_id = p_organization and g.valid_from > now()
    union all
    select g.valid_to from org.effective_access_grant g
     where g.organization_id = p_organization and g.valid_to > now()
    union all
    select ra.valid_from from org.role_assignment ra
     where ra.subject_id = p_person and ra.valid_from > now()
    union all
    select ra.valid_to from org.role_assignment ra
     where ra.subject_id = p_person and ra.valid_to > now()
  ) as boundaries(boundary)
$$;

revoke all on function content.master_record_currency_boundary(uuid, uuid) from public;

/**
 * Record that the bound person's own compilation found `p_master_record` current as of
 * `p_snapshot`, the snapshot taken before the compilation read anything. Everything else comes
 * from the sealed context and the database: the organization, the acting role, the rank, the act,
 * the claim's format, the catalog fingerprint and the validity boundary. It records nothing (null)
 * for a claim that is not the bound principal's, outside an act, or in an administrator session,
 * and refuses a snapshot later than the present one — a snapshot can only make the shortcut apply
 * to writes the reading saw, and a later one would claim to have seen writes it had not.
 */
create function content.record_master_record_currency(p_master_record uuid, p_snapshot pg_snapshot)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_org     uuid := core.current_organization();
  -- The person and assignment the principal was bound as (core.bind_principal): the same two a
  -- reading of the record is bound as, which is what content.master_record_current_format matches.
  v_actor   uuid := core.sealed_setting('kf.principal', true)::uuid;
  v_role    uuid := core.sealed_setting('kf.principal_assignment', true)::uuid;
  v_action  uuid := core.current_action_id();
  v_now     pg_snapshot := pg_current_snapshot();
  v_format  text;
  v_id      uuid;
begin
  -- Nothing is recorded for a compilation a principal's reading cannot rely on: one outside an
  -- act of a bound principal, one an administrator session made (row security did not bind what
  -- it read), or one of somebody else's claim. Such a claim is still checked on every reading, by
  -- enumerating; only the shortcut is withheld.
  if v_org is null or v_actor is null or v_role is null or v_action is null
     or core.session_is_administrator() then
    return null;
  end if;
  select master.manifest ->> 'format' into v_format
    from content.master_record master
   where master.id = p_master_record
     and master.person_id = v_actor
     and master.organization_id = v_org;
  if not found then
    return null;
  end if;
  if p_snapshot is null
     or pg_snapshot_xmin(p_snapshot) > pg_snapshot_xmin(v_now)
     or pg_snapshot_xmax(p_snapshot) > pg_snapshot_xmax(v_now) then
    raise exception 'a currency snapshot cannot be later than the present one'
      using errcode = 'insufficient_privilege';
  end if;
  insert into content.master_record_currency
    (master_record_id, organization_id, acting_role_id, classification_rank, manifest_format,
     snapshot, schema_fingerprint, valid_until, recorded_by_action)
  values (
    p_master_record, v_org, v_role, core.current_classification_rank(), v_format, p_snapshot,
    content.master_record_schema_fingerprint(),
    content.master_record_currency_boundary(v_actor, v_org),
    v_action
  )
  returning id into v_id;
  return v_id;
end
$$;

revoke all on function content.record_master_record_currency(uuid, pg_snapshot) from public;
grant execute on function content.record_master_record_currency(uuid, pg_snapshot) to kf_app;

/**
 * The manifest format of `p_master_record` when the claim is provably current for the bound person
 * under the bound context without enumerating its corpus; null when that cannot be shown (which is
 * not "stale": the caller then enumerates). Reads the write log as the owner and returns one
 * value, so no application role can read which transactions wrote what.
 */
create function content.master_record_current_format(p_master_record uuid)
returns text
language sql
stable
security definer
set search_path = pg_catalog
as $$
  select currency.manifest_format
    from content.master_record_currency currency
    join content.master_record master on master.id = currency.master_record_id
   where currency.master_record_id = p_master_record
     and master.person_id = core.sealed_setting('kf.principal', true)::uuid
     and master.organization_id = core.current_organization()
     and currency.organization_id = core.current_organization()
     and currency.acting_role_id = core.sealed_setting('kf.principal_assignment', true)::uuid
     and currency.classification_rank = core.current_classification_rank()
     and currency.expires_at > now()
     and (currency.valid_until is null or currency.valid_until > now())
     and currency.schema_fingerprint = content.master_record_schema_fingerprint()
     and not exists (
       select 1 from content.master_record_input_write written
        where (written.organization_id = currency.organization_id
               or written.organization_id is null)
          and written.xact >= pg_snapshot_xmin(currency.snapshot)
          and not pg_visible_in_snapshot(written.xact, currency.snapshot)
     )
   order by currency.recorded_at desc, currency.id desc
   limit 1
$$;

revoke all on function content.master_record_current_format(uuid) from public;
grant execute on function content.master_record_current_format(uuid) to kf_app;

-- The sweep names every declared transient table (tests/database/transient-observations.test.ts).
-- Currency rows first; then every write row that is expired AND older than what the oldest live
-- currency row still needs, so a swept write can never make a stale claim read as current.
create or replace function core.sweep_transient_observations()
returns table (table_name text, removed bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_count bigint;
begin
  delete from search.recorded_query where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.recorded_query'; removed := v_count; return next;

  delete from search.demand_contribution where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.demand_contribution'; removed := v_count; return next;

  delete from retrieval.disclosure where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'retrieval.disclosure'; removed := v_count; return next;

  delete from search.context_disclosure where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.context_disclosure'; removed := v_count; return next;

  delete from content.master_record_currency where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'content.master_record_currency'; removed := v_count; return next;

  delete from content.master_record_input_write written
   where written.expires_at <= now()
     and written.xact < coalesce(
       (select min(pg_snapshot_xmin(currency.snapshot)) from content.master_record_currency currency),
       pg_snapshot_xmin(pg_current_snapshot()));
  get diagnostics v_count = row_count;
  table_name := 'content.master_record_input_write'; removed := v_count; return next;

  -- The key last: a row swept above may still have been keyed by it.
  delete from search.asker_key where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.asker_key'; removed := v_count; return next;
end
$$;

-- migrate:down

create or replace function core.sweep_transient_observations()
returns table (table_name text, removed bigint)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_count bigint;
begin
  delete from search.recorded_query where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.recorded_query'; removed := v_count; return next;

  delete from search.demand_contribution where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.demand_contribution'; removed := v_count; return next;

  delete from retrieval.disclosure where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'retrieval.disclosure'; removed := v_count; return next;

  delete from search.context_disclosure where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.context_disclosure'; removed := v_count; return next;

  -- The key last: a row swept above may still have been keyed by it.
  delete from search.asker_key where expires_at <= now();
  get diagnostics v_count = row_count;
  table_name := 'search.asker_key'; removed := v_count; return next;
end
$$;

drop function content.master_record_current_format(uuid);
drop function content.record_master_record_currency(uuid, pg_snapshot);
drop function content.master_record_currency_boundary(uuid, uuid);
drop function content.master_record_schema_fingerprint();

do $$
declare
  r record;
begin
  for r in
    select format('%I.%I', n.nspname, c.relname) as tbl
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where t.tgname = 'zz_master_record_input_written'
  loop
    execute format('drop trigger zz_master_record_input_written on %s', r.tbl);
  end loop;
end
$$;

drop function content.install_master_record_input_triggers();
drop function content.note_master_record_input_write();
drop table content.master_record_currency;
drop table content.master_record_input_write;
drop table content.master_record_input_exemption;
