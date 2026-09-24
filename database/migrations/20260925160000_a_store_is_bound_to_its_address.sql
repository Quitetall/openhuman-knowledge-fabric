-- migrate:up

-- A declared store carries its address, and a process that claims it must be configured with
-- that address (KF-SAS-RQ-095, SAS §100.5, ADR 0017 note of 2026-09-25).
--
-- `content.artifact_store` declared an id, a kind and a label. Every program that held a store
-- built its S3 client from its own environment, so nothing could say that the bucket the API
-- wrote into, the bucket the worker read from, and the bucket the ledger calls `working` were
-- one bucket. A worker pointed at yesterday's bucket read and wrote there with no finding.
--
-- The address is `endpoint` + `bucket`. Never credentials: the endpoint is refused if it carries
-- userinfo, and the secret stays instance configuration, as the table comment has always said.
--
-- WRITTEN THROUGH ONE SEAM. No application login may INSERT or UPDATE this table; `content.bind_artifact_store` is
-- SECURITY DEFINER and does exactly three things: declares an object store that is not yet
-- declared (ADR 0017 says the app registers `durable`, and until now nothing did), binds an
-- address to a declared object store that has none, and refuses an address that differs from
-- the bound one. A bound address is never rebound by this seam; moving a store is a migration
-- that says why.
--
-- NOT DECIDED HERE: who approves the first address. The first process to present one binds it,
-- the same trust `declareStore` already extended. What the binding buys is that every LATER
-- process is held to it.

alter table content.artifact_store
  add column endpoint text
    check (endpoint is null or endpoint ~ '^https?://[^/?#@[:space:]]+(/[^?#@[:space:]]*)?$'),
  add column bucket text
    check (bucket is null or bucket ~ '^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$'),
  add column bound_at timestamptz,
  add constraint artifact_store_address_complete check (
    (endpoint is null and bucket is null and bound_at is null)
    or (endpoint is not null and bucket is not null and bound_at is not null)
  ),
  add constraint artifact_store_address_is_an_object_store check (
    endpoint is null or kind = 'object_store'
  );

comment on column content.artifact_store.endpoint is
  'The S3-wire endpoint this store is reached at, normalised (scheme://host[:port][/path], no '
  'trailing slash, no userinfo). Bound once by content.bind_artifact_store (KF-SAS-RQ-095).';
comment on column content.artifact_store.bucket is
  'The bucket this store is. A process configured with another bucket under this id is refused.';
comment on column content.artifact_store.bound_at is
  'When the address was bound. Null while the store has no address (memory stores never do).';

create function content.bind_artifact_store(
  p_id text,
  p_label text,
  p_endpoint text,
  p_bucket text
) returns void
language plpgsql
security definer
set search_path = pg_catalog, content
as $$
declare
  v_store content.artifact_store%rowtype;
begin
  if p_id is null or p_endpoint is null or p_bucket is null then
    raise exception 'bind_artifact_store requires a store id, an endpoint and a bucket'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_store from content.artifact_store where id = p_id for update;
  if not found then
    insert into content.artifact_store (id, kind, label, endpoint, bucket, bound_at)
    values (p_id, 'object_store', coalesce(nullif(btrim(p_label), ''), p_id), p_endpoint,
            p_bucket, now());
    return;
  end if;

  if v_store.kind <> 'object_store' then
    raise exception 'artifact_store_address_mismatch: store % is declared %, not an object store',
      p_id, v_store.kind using errcode = 'check_violation';
  end if;

  if v_store.endpoint is null then
    update content.artifact_store
       set endpoint = p_endpoint, bucket = p_bucket, bound_at = now()
     where id = p_id;
    return;
  end if;

  if v_store.endpoint is distinct from p_endpoint or v_store.bucket is distinct from p_bucket then
    raise exception
      'artifact_store_address_mismatch: store % is registered at % bucket %, configured at % bucket %',
      p_id, v_store.endpoint, v_store.bucket, p_endpoint, p_bucket
      using errcode = 'check_violation';
  end if;
end
$$;

comment on function content.bind_artifact_store(text, text, text, text) is
  'KF-SAS-RQ-095: declare an unknown object store, bind an address to an unaddressed one, and '
  'refuse any address that differs from the bound one. Never rebinds.';

revoke all on function content.bind_artifact_store(text, text, text, text) from public;
grant execute on function content.bind_artifact_store(text, text, text, text) to kf_app, kf_worker;

-- The seam is now the only way an application login declares a store. kf_app's direct INSERT
-- (20260902000200) was used by nothing outside owner-credential fixtures, and under the write
-- guard (20260925011000) it could not be used without an act — while declaring the store a
-- process was configured with happens at startup, before anyone has acted. So the grant goes,
-- and with it the guard triggers `core.install_action_context_guards` attached because of it:
-- a table no application login can write needs no act guard, and the seam's own refusals are
-- the control. Re-running the installer after this migration leaves the table unguarded for
-- the same reason (it attaches only where kf_app or kf_worker holds a write privilege).
revoke insert on content.artifact_store from kf_app;
drop trigger if exists zz_written_under_an_act on content.artifact_store;
drop trigger if exists written_act_is_recorded on content.artifact_store;

-- migrate:down

grant insert on content.artifact_store to kf_app;
select core.install_action_context_guards();
drop function content.bind_artifact_store(text, text, text, text);
alter table content.artifact_store
  drop constraint artifact_store_address_is_an_object_store,
  drop constraint artifact_store_address_complete,
  drop column bound_at,
  drop column bucket,
  drop column endpoint;
