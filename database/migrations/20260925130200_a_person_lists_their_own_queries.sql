-- migrate:up

-- A person may list, and so replay, their own recorded queries (KF-SAS-RQ-221, §64B).
--
-- search.recorded_query names nobody: the asker is an HMAC of the person under a key in
-- search.asker_key, and kf_app may read neither the key nor the asker column. So "my queries"
-- cannot be a WHERE clause the application writes. This seam recomputes the BOUND principal's
-- asker key — the same identity search.record_query hashed, the principal or, for a service, the
-- acting identity — under every live pseudonym key (a query recorded before the latest rotation
-- still carries the older one) and returns the rows that carry it. It takes no person argument,
-- so it cannot be pointed at anybody else, and it returns no key.
--
-- Also held to the caller's current ceiling, as the table's read policy holds every reader: a
-- person whose clearance was lowered does not get back the text of a question asked above it.

create function search.my_recorded_queries(p_id uuid default null)
returns table (
  id            uuid,
  query_text    text,
  asker_ceiling text,
  recorded_at   timestamptz,
  expires_at    timestamptz
)
language plpgsql
stable
security definer
set search_path = pg_catalog, core, search
as $$
declare
  v_asker text := coalesce(core.sealed_setting('kf.principal', true),
                           core.sealed_setting('kf.actor', true));
  v_org   uuid := core.current_organization();
  v_rank  integer := core.current_classification_rank();
begin
  if v_asker is null or v_org is null then
    raise exception 'recorded queries are listed only for a bound principal'
      using errcode = 'insufficient_privilege';
  end if;
  return query
    select q.id, q.query_text, q.asker_ceiling, q.recorded_at, q.expires_at
      from search.recorded_query q
     where q.organization_id = v_org
       and q.expires_at > now()
       and q.asker_rank <= v_rank
       and (p_id is null or q.id = p_id)
       and q.asker_key in (
         select public.hmac(convert_to(v_asker, 'UTF8'), k.key, 'sha256')
           from search.asker_key k
          where k.expires_at > now())
     order by q.recorded_at desc, q.id desc
     limit 200;
end
$$;

revoke all on function search.my_recorded_queries(uuid) from public;
grant execute on function search.my_recorded_queries(uuid) to kf_app;

-- migrate:down

drop function search.my_recorded_queries(uuid);
