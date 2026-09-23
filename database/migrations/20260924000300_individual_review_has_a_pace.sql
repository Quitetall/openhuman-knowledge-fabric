-- migrate:up

-- A verification's basis is checked against how fast it was recorded (KF-SAS-RQ-231).
--
-- `core.object_verification.basis` says whether a person looked at this record
-- (`reviewed_individually`) or promoted it with many others in one gesture (`promoted_in_bulk`).
-- The caller declared it, and nothing checked the declaration: a script verifying five hundred
-- records at `reviewed_individually` was recorded as five hundred individual reviews. Threat
-- model T2 listed it as not mitigated.
--
-- Two halves close it. The API now has a bulk gesture (`POST /verifications/bulk`) that stamps
-- `promoted_in_bulk` itself, so promoting many records is a supported path with no reason to
-- misdeclare. And the database refuses `reviewed_individually` from a verifier who recorded
-- another one less than INDIVIDUAL_REVIEW_INTERVAL earlier. A person reading records does not
-- finish two within it; a script does. The interval is deliberately short: it is not a quota on
-- how much a person may review in a day, only the floor below which "I read it" is not a
-- claim a human could be making.
--
-- THE CLOCK IS THE DATABASE'S. `verified_at` was a column the inserting role could set, so a
-- script could have spaced its claims out on paper. Outside an administrator session it is now
-- always `now()` — the transaction's start — whatever the insert said.
--
-- CONCURRENCY. Two transactions by the same verifier cannot see each other's uncommitted row,
-- so the check takes a transaction-scoped advisory lock on the verifier first: the second waits
-- for the first to commit, then sees it. The dispatcher asks the same function in its
-- precondition, before the insert, so the lock is held from there and the refusal reaches the
-- caller as `precondition_failed` with the way out in the message, not as a database error.
--
-- A restore does not pass through this: the importer disables user triggers while it loads.

-- THE CONSTANT. One place; the message and the check both read it.
create function core.individual_review_interval() returns interval
language sql
immutable
as $$ select interval '1 second' $$;

comment on function core.individual_review_interval() is
  'INDIVIDUAL_REVIEW_INTERVAL: the least time between two reviewed_individually verifications by '
  'one verifier. Below it the claim is not one a person reading records could be making.';

-- The refusal, or NULL. SECURITY DEFINER: the verifier's other verifications may be on records
-- above the current ceiling, and a check that could not see them would be evaded by them.
create function core.individual_review_refusal(p_verifier uuid) returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, core
as $$
declare
  v_last timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('kf.individual_review:' || p_verifier::text, 0));
  select max(v.verified_at) into v_last
    from core.object_verification v
   where v.verified_by = p_verifier
     and v.basis = 'reviewed_individually';
  if v_last is null or v_last <= now() - core.individual_review_interval() then
    return null;
  end if;
  return format(
    'verify_record: this verifier recorded another individual review less than %ss ago, and a '
    || 'person reading records does not finish two in that time (KF-SAS-RQ-231). To promote '
    || 'many records at once, use POST /verifications/bulk, which records them as '
    || 'promoted_in_bulk; to record an individual review, retry it',
    extract(epoch from core.individual_review_interval())::float8);
end
$$;

revoke all on function core.individual_review_refusal(uuid) from public;
grant execute on function core.individual_review_refusal(uuid) to kf_app;

create function core.object_verification_paced() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core
as $$
declare
  v_refusal text;
begin
  if core.session_is_administrator() then
    return new;
  end if;
  new.verified_at := now();
  if new.basis = 'reviewed_individually' then
    v_refusal := core.individual_review_refusal(new.verified_by);
    if v_refusal is not null then
      raise exception '%', v_refusal
        using errcode = 'check_violation',
              hint = 'POST /verifications/bulk records many records as promoted_in_bulk.';
    end if;
  end if;
  return new;
end
$$;

revoke all on function core.object_verification_paced() from public;
grant execute on function core.object_verification_paced() to kf_app;

create trigger object_verification_paced
  before insert on core.object_verification
  for each row execute function core.object_verification_paced();

-- migrate:down

drop trigger object_verification_paced on core.object_verification;
drop function core.object_verification_paced();
drop function core.individual_review_refusal(uuid);
drop function core.individual_review_interval();
