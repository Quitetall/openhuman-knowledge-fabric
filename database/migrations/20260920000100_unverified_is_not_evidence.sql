-- migrate:up

-- An unverified record cannot be cited as evidence (KF-SAS-RQ-230).
--
-- §48A: a Warrant tracing to a record nobody has checked is a claim resting on nothing, which is
-- the ticked box §97.3 exists to prevent. This is the single place an unverified record is not a
-- record like any other, and it is where the distinction earns its keep.
--
-- `work.warrant_evidence.evidence_ref` is free text by design — evidence is often a URL, a run
-- id, a document number from a system that is not this one. So this refuses the case it can
-- recognise: a reference that names a record IN THIS DATABASE which nothing has verified. A
-- reference to anything else is out of scope here and always was; §41's admissibility fields
-- carry that judgement instead.

/**
 * Whether an evidence reference names an unverified record of this Fabric.
 *
 * SECURITY DEFINER, and the reason matters. Checked as the caller, `core.object`'s row security
 * would hide a record above their ceiling, `exists` would be false, and the citation would be
 * ALLOWED — the refusal would apply to exactly the records the caller can already see and to
 * none of the ones they cannot. A check that is weaker precisely where visibility is tighter is
 * not a check.
 *
 * It answers one boolean about an identifier the caller supplied, and reveals nothing else.
 */
create or replace function work.evidence_ref_is_unverified_record(p_ref text) returns boolean
language plpgsql
stable
security definer
set search_path = core, work, pg_catalog
as $$
declare
  v_object uuid;
begin
  begin
    v_object := p_ref::uuid;
  exception
    when invalid_text_representation then
      -- Not an identifier of this Fabric at all. Out of scope, not refused.
      return false;
  end;

  return exists (select 1 from core.object where id = v_object)
     and not exists (select 1 from core.object_verification where object_id = v_object);
end
$$;

revoke execute on function work.evidence_ref_is_unverified_record(text) from public;
grant execute on function work.evidence_ref_is_unverified_record(text) to kf_app, kf_worker;

create or replace function work.refuse_unverified_evidence() returns trigger
language plpgsql
as $$
begin
  if work.evidence_ref_is_unverified_record(new.evidence_ref) then
    raise exception
      'evidence % names a record of this Fabric that nothing has verified; a Warrant cannot '
      'rest on a record nobody has checked (KF-SAS-RQ-230)', new.evidence_ref
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

-- Fires on update as well as insert. An evidence row repointed at an unverified record afterwards
-- is the same defect arriving a second later, and a guard that only watches the door is not a
-- guard.
create trigger warrant_evidence_refuse_unverified
  before insert or update of evidence_ref on work.warrant_evidence
  for each row execute function work.refuse_unverified_evidence();

comment on trigger warrant_evidence_refuse_unverified on work.warrant_evidence is
  'KF-SAS-RQ-230. Refuses evidence naming an unverified record of this Fabric. A reference to '
  'anything else is out of scope; §41 admissibility carries that judgement.';

-- migrate:down

drop trigger if exists warrant_evidence_refuse_unverified on work.warrant_evidence;
drop function if exists work.refuse_unverified_evidence();
drop function if exists work.evidence_ref_is_unverified_record(text);
