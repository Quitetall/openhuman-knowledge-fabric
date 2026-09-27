-- migrate:up

-- Every audit-chain link names the format its digest was computed under, and every new link
-- carries that format inside its preimage.
--
-- KF-SAS-RQ-016 requires every digest to be taken over an RFC 8785 canonical form under a named
-- format tag that is part of the preimage. The chain link was the exception SAS §100.27
-- recorded: sha256(prev || canonical(eight fields)), no tag. It cannot simply be re-hashed —
-- the chain is append-only, every link commits to the one before it, and signed checkpoints
-- and backups already hold the v1 bytes — so the change is a new format beside the old one:
--
--   kf-audit-link-v1  sha256(prev || canonical({eight fields}))                   (as recorded)
--   kf-audit-link-v2  sha256(prev || canonical({eight fields, format: 'kf-audit-link-v2'}))
--
-- The tag sits in the preimage as a `format` property, the way `kf-action-request-v1` and every
-- other tagged digest in the codebase carries it. Each row records its own format. Rows already
-- in the log are v1 — the ADD COLUMN default fills them — and the default then becomes v2, so a
-- writer never names a format: the database sets it, and refuses a new row that names any other.
-- A v1 link after this migration is refused twice over: its format by the check below, and a
-- v1 digest under a v2 row by the recomputation. Verifiers outside the database (checkpoint
-- signer and ledger verifier, export importer, idempotent replay) recompute each link under its
-- recorded format and refuse a v1 link that follows a v2 one.

alter table core.audit_event
  add column link_format text not null default 'kf-audit-link-v1'
    constraint audit_event_link_format_known
      check (link_format in ('kf-audit-link-v1', 'kf-audit-link-v2'));

alter table core.audit_event alter column link_format set default 'kf-audit-link-v2';

comment on column core.audit_event.link_format is
  'The format this link''s digest was computed under. kf-audit-link-v1: the untagged preimage '
  'every link before 20260924001100 used. kf-audit-link-v2: the same fields with format in the '
  'preimage. Set by the database (the default); a new row naming anything else is refused.';

-- The digest under a named format. v1 is the existing nine-argument function, unchanged, so
-- what verified yesterday verifies today; v2 inserts `"format":"kf-audit-link-v2"` where RFC
-- 8785's code-point key order puts it, between `effective_at` and `object_ids`.
create function core.audit_event_digest(
  p_link_format text,
  p_prev_digest text,
  p_action_id uuid,
  p_action_type text,
  p_actor_id uuid,
  p_acting_role_id uuid,
  p_object_ids uuid[],
  p_effective_at timestamptz,
  p_before_digest text,
  p_after_digest text
) returns text
language plpgsql
stable
set search_path = pg_catalog
as $$
begin
  if p_link_format = 'kf-audit-link-v1' then
    return core.audit_event_digest(
      p_prev_digest, p_action_id, p_action_type, p_actor_id, p_acting_role_id, p_object_ids,
      p_effective_at, p_before_digest, p_after_digest);
  end if;
  if p_link_format is distinct from 'kf-audit-link-v2' then
    raise exception 'unknown audit link format %', p_link_format
      using errcode = 'invalid_parameter_value';
  end if;
  return encode(sha256(decode(p_prev_digest, 'hex') || convert_to(
    '{"acting_role_id":' || to_json(p_acting_role_id::text)::text
    || ',"action_id":' || to_json(p_action_id::text)::text
    || ',"action_type":' || to_json(p_action_type)::text
    || ',"actor_id":' || to_json(p_actor_id::text)::text
    || ',"after_digest":' || coalesce(to_json(p_after_digest)::text, 'null')
    || ',"before_digest":' || coalesce(to_json(p_before_digest)::text, 'null')
    || ',"effective_at":' || to_json(to_char(p_effective_at at time zone 'UTC',
                                             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text
    || ',"format":"kf-audit-link-v2"'
    || ',"object_ids":[' || coalesce((
         select string_agg(to_json(id::text)::text, ',' order by id::text collate "C")
           from unnest(p_object_ids) as id), '')
    || ']}',
    'UTF8')), 'hex');
end
$$;

comment on function core.audit_event_digest(text, text, uuid, text, uuid, uuid, uuid[], timestamptz, text, text) is
  'The audit-chain digest under a named link format (kf-audit-link-v1 or kf-audit-link-v2), '
  'computed by the database. Must equal @kf/canonicalization auditChainDigest byte for byte; '
  'tests/database/principal-binding.test.ts pins the two together for both formats.';

comment on function core.audit_event_digest(text, uuid, text, uuid, uuid, uuid[], timestamptz, text, text) is
  'The kf-audit-link-v1 (untagged) audit-chain digest, which every link recorded before '
  '20260924001100 carries. Must equal @kf/canonicalization auditChainDigest(..., '
  '''kf-audit-link-v1'') byte for byte; tests/database/principal-binding.test.ts pins the two.';

-- Unchanged from 20260923000200 but for the format: a new link is v2, and is recomputed as v2.
create or replace function core.enforce_audit_chain_head() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core
as $$
declare
  v_seq bigint;
  v_digest text;
  v_action core.action;
begin
  select head.seq, head.digest into strict v_seq, v_digest
    from core.audit_chain_head head
   where head.singleton
   for update;

  if new.seq <= v_seq then
    raise exception 'audit event sequence % does not advance global head %', new.seq, v_seq
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.prev_digest is distinct from v_digest then
    raise exception 'audit event predecessor does not match global chain head'
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.link_format is distinct from 'kf-audit-link-v2' then
    raise exception 'audit event link format % is not kf-audit-link-v2', new.link_format
      using errcode = 'integrity_constraint_violation',
            hint = 'Every link appended since 20260924001100 is kf-audit-link-v2; leave '
                   'link_format to its default.';
  end if;

  select * into v_action from core.action where id = new.action_id;
  if v_action.id is null then
    raise exception 'audit event names action %, which is not in the ledger', new.action_id
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_action.actor_id is distinct from new.actor_id
     or v_action.acting_role_id is distinct from new.acting_role_id
     or v_action.action_type is distinct from new.action_type then
    raise exception 'audit event does not describe its own action truthfully'
      using errcode = 'integrity_constraint_violation';
  end if;
  if not core.session_is_administrator()
     and new.action_id is distinct from core.current_action_id() then
    raise exception 'audit event must record the action this transaction is performing'
      using errcode = 'insufficient_privilege';
  end if;
  if new.digest is distinct from core.audit_event_digest(
       new.link_format, new.prev_digest, new.action_id, new.action_type, new.actor_id,
       new.acting_role_id, v_action.target_ids, new.effective_at, new.before_digest,
       new.after_digest) then
    raise exception 'audit event digest does not match its content'
      using errcode = 'integrity_constraint_violation',
            hint = 'The database recomputes every link; a digest it cannot reproduce is refused.';
  end if;

  update core.audit_chain_head set seq = new.seq, digest = new.digest where singleton;
  return new;
end
$$;

-- Readiness counts a link whose format regresses as a break, alongside one that does not link.
create or replace function core.readiness_audit_chain()
returns table (breaks bigint, total bigint)
language sql
stable
security definer
set search_path = pg_catalog, core
as $$
  with linked as (
    select seq,
           prev_digest,
           lag(digest) over (order by seq) as expected_prev,
           link_format,
           lag(link_format) over (order by seq) as previous_format
      from core.audit_event
  )
  select count(*) filter (
           where (expected_prev is null and prev_digest <> repeat('0', 64))
              or (expected_prev is not null and prev_digest <> expected_prev)
              or (previous_format = 'kf-audit-link-v2' and link_format = 'kf-audit-link-v1')
         )::bigint,
         count(*)::bigint
    from linked
$$;

-- migrate:down
-- kf:forward-only links appended after this migration are kf-audit-link-v2 and verify only under the format each row records; dropping the column or restoring the untagged trigger would make every one of them unverifiable and refuse the next append
