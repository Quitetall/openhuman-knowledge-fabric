-- migrate:up

-- The urgent push's boundary is (time, item), at the database's own precision (KF-SAS-RQ-274;
-- docs/agents/in-app-agent.md, "Limits").
--
-- `core.urgent_notifications(since)` of 20261007300000 compared `date_trunc('milliseconds',
-- arose_at) > since`, because the notifier kept its boundary as a JavaScript instant, which holds
-- milliseconds. Two items arising in one millisecond, the second committed after a run had seen
-- the first, were lost: the boundary had moved to that millisecond and the second was not after
-- it. The digest still listed it; the push never came.
--
-- Now the boundary is the pair (arose_at, item id), compared as a row at microseconds, so a later
-- item in the same instant is after the boundary by its id, and an item seen is never after it.
-- The notifier keeps the instant as the database's text, not as a JavaScript Date, so nothing is
-- rounded on the way round. The item id is a proposal's or a blocker's identifier; the notifier
-- keeps it as its boundary only, never in a push and never in its log.
--
-- What this does not fix, recorded where it is stated: `arose_at` is when the item's transaction
-- began. An item whose transaction began before a run and committed after it is behind a boundary
-- that run moved past. The window is how long a proposing transaction stays open (milliseconds
-- for an act through the API), not one millisecond; the digest lists such an item regardless.

drop function core.urgent_notifications(timestamptz);

create function core.urgent_notifications(p_since timestamptz, p_since_item uuid)
returns table (person_id uuid, kind text, arose_at timestamptz, item_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, core, org, work
as $$
  select * from (
    select p.proposed_for as person_id, 'proposal_waiting'::text as kind,
           p.proposed_at as arose_at, p.id as item_id
      from core.act_proposal p
     where (p.proposed_at, p.id) > (p_since, coalesce(p_since_item, '00000000-0000-0000-0000-000000000000'::uuid))
       and not exists (select 1 from core.act_proposal_resolution x where x.proposal_id = p.id)
       and coalesce(
             (select np.push from core.notification_preference np
               where np.organization_id = p.organization_id and np.person_id = p.proposed_for
               order by np.revision desc limit 1),
             'urgent') = 'urgent'
    union all
    select ra.subject_id, 'blocker_opened'::text, b.opened_at, b.id
      from work.warrant_blocker b
      join core.object warrant_object on warrant_object.id = b.warrant_id
      join org.role_assignment ra
        on ra.role_id = 'technical_authority'
       and ra.scope_id = warrant_object.organization_id
       and ra.valid_from <= now() and (ra.valid_to is null or ra.valid_to > now())
     where (b.opened_at, b.id) > (p_since, coalesce(p_since_item, '00000000-0000-0000-0000-000000000000'::uuid))
       and b.resolved_at is null
       and coalesce(
             (select np.push from core.notification_preference np
               where np.organization_id = warrant_object.organization_id
                 and np.person_id = ra.subject_id
               order by np.revision desc limit 1),
             'urgent') = 'urgent'
  ) urgent
  order by arose_at, item_id
$$;

revoke all on function core.urgent_notifications(timestamptz, uuid) from public;
grant execute on function core.urgent_notifications(timestamptz, uuid) to kf_notifier;

comment on role kf_notifier is
  'kf-notify''s login inherits this and nothing else: execute on core.needs_you_digest() and '
  'core.urgent_notifications(timestamptz, uuid). It reads no table; what a notification may say is '
  'decided by those functions (KF-SAS-RQ-274).';

-- migrate:down

drop function core.urgent_notifications(timestamptz, uuid);

create function core.urgent_notifications(p_since timestamptz)
returns table (person_id uuid, kind text, arose_at timestamptz)
language sql
stable
security definer
set search_path = pg_catalog, core, org, work
as $$
  select p.proposed_for, 'proposal_waiting'::text, p.proposed_at
    from core.act_proposal p
   where date_trunc('milliseconds', p.proposed_at) > p_since
     and not exists (select 1 from core.act_proposal_resolution x where x.proposal_id = p.id)
     and coalesce(
           (select np.push from core.notification_preference np
             where np.organization_id = p.organization_id and np.person_id = p.proposed_for
             order by np.revision desc limit 1),
           'urgent') = 'urgent'
  union all
  select ra.subject_id, 'blocker_opened'::text, b.opened_at
    from work.warrant_blocker b
    join core.object warrant_object on warrant_object.id = b.warrant_id
    join org.role_assignment ra
      on ra.role_id = 'technical_authority'
     and ra.scope_id = warrant_object.organization_id
     and ra.valid_from <= now() and (ra.valid_to is null or ra.valid_to > now())
   where date_trunc('milliseconds', b.opened_at) > p_since
     and b.resolved_at is null
     and coalesce(
           (select np.push from core.notification_preference np
             where np.organization_id = warrant_object.organization_id
               and np.person_id = ra.subject_id
             order by np.revision desc limit 1),
           'urgent') = 'urgent'
$$;

revoke all on function core.urgent_notifications(timestamptz) from public;
grant execute on function core.urgent_notifications(timestamptz) to kf_notifier;

comment on role kf_notifier is
  'kf-notify''s login inherits this and nothing else: execute on core.needs_you_digest() and '
  'core.urgent_notifications(timestamptz). It reads no table; what a notification may say is '
  'decided by those functions (KF-SAS-RQ-274).';
