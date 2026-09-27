-- migrate:up

-- A revision check is a recorded disclosure too (KF-SAS-RQ-219, §59, §64B).
--
-- `POST /context-source/revision` (apps/api/src/routes/context-source.ts) answers LAMU's recheck
-- (PERF-09) without the text: the same current-authority decision as `read`, answering only
-- {revision, digest}. What it discloses is that the record is still readable by the caller, still
-- in their agent_context at that revision, and still has that text digest — so it is recorded as
-- `read` is, with operation `revision`, in the same transaction, and with no text (the table has no
-- text column). An answered revision check has the shape of an answered read: corpus, record,
-- revision and text digest; its refusals follow the same rules, KF-CTX-001 naming nothing.

alter table search.context_disclosure
  drop constraint context_disclosure_operation_check,
  add constraint context_disclosure_operation_check
    check (operation in ('retrieve', 'read', 'revision')),
  drop constraint context_disclosure_shape,
  add constraint context_disclosure_shape check (
    (refusal is null and corpus_digest is not null and operation in ('read', 'revision')
       and object_id is not null and revision is not null and text_digest is not null
       and references_digest is null)
    or (refusal is null and corpus_digest is not null and operation = 'retrieve'
       and object_id is null and revision is null and text_digest is null
       and references_digest is not null and reference_count is not null
       and omitted_count is not null)
    or (refusal = 'KF-CTX-001' and object_id is null and revision is null and text_digest is null)
    or (refusal is not null and refusal <> 'KF-CTX-001')
  );

comment on table search.context_disclosure is
  'Transient observation (§64B, KF-SAS-RQ-219): each context-source retrieval, read and revision '
  'check, answered or refused, bound to the asker''s agent_context corpus digest, with the declared '
  'agent from the attestation. No text, no query, no person column (a pseudonymous asker key). '
  'Expires after 90 days.';

create or replace function search.record_context_disclosure(
  p_operation         text,
  p_refusal           text,
  p_corpus_digest     text,
  p_object            uuid,
  p_revision          text,
  p_text_digest       text,
  p_references_digest text,
  p_reference_count   integer,
  p_omitted_count     integer
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, core, search, content, registry
as $$
declare
  v_principal text := core.sealed_setting('kf.principal', true);
  v_org       uuid := core.current_organization();
  v_rank      integer := core.current_classification_rank();
  v_latest    text;
  v_claim     uuid;
  v_id        uuid;
begin
  if v_principal is null or v_org is null then
    raise exception 'a context disclosure is recorded only for a bound person'
      using errcode = 'insufficient_privilege';
  end if;

  if p_corpus_digest is not null then
    select m.id, m.corpus_digest into v_claim, v_latest
      from content.master_record m
      join registry.classification c on c.id = m.effective_classification
     where m.person_id = v_principal::uuid
       and m.organization_id = v_org
       and c.rank <= v_rank
     order by m.compiled_at desc, m.recorded_at desc, m.id desc
     limit 1;
    if v_latest is distinct from p_corpus_digest then
      raise exception 'corpus digest % is not the bound person''s current master record', p_corpus_digest
        using errcode = 'insufficient_privilege';
    end if;
    -- A read, or a revision check, is bound to the claim only if the claim included that record
    -- at that revision: the record is then a member of the person's agent_context, exactly as
    -- disclosed (a revision check discloses that it still is).
    if p_operation in ('read', 'revision') and p_refusal is null and not exists (
      select 1 from content.master_record_item i
       where i.master_record_id = v_claim
         and i.object_id = p_object
         and i.item_state = 'included'
         and i.content_digest = p_revision) then
      raise exception 'record % at revision % is not in the master record it is bound to',
        p_object, p_revision
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if p_refusal = 'KF-CTX-001' and p_object is not null then
    raise exception 'a record that was not found is not named'
      using errcode = 'insufficient_privilege';
  end if;

  if p_object is not null then
    if p_refusal = 'KF-CTX-002' then
      if not exists (
        select 1
          from content.master_record m
          join registry.classification c on c.id = m.effective_classification
          join content.master_record_item i on i.master_record_id = m.id
         where m.person_id = v_principal::uuid
           and m.organization_id = v_org
           and c.rank <= v_rank
           and i.object_id = p_object
           and i.item_state = 'included') then
        raise exception 'record % was never in the bound person''s master record', p_object
          using errcode = 'insufficient_privilege';
      end if;
    elsif not exists (
      select 1
        from core.object o
        join registry.classification c on c.id = o.classification
       where o.id = p_object
         and o.organization_id = v_org
         and c.rank <= v_rank) then
      raise exception 'record % is not within the bound context', p_object
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  insert into search.context_disclosure
    (organization_id, operation, refusal, corpus_digest, object_id, revision, text_digest,
     references_digest, reference_count, omitted_count, agent_participation, asker_rank, asker_key)
  values (
    v_org, p_operation, p_refusal, p_corpus_digest, p_object, p_revision, p_text_digest,
    p_references_digest, p_reference_count, p_omitted_count,
    core.sealed_setting('kf.agent_participation', true),
    v_rank,
    public.hmac(convert_to(v_principal, 'UTF8'), search.current_asker_key(), 'sha256')
  )
  returning id into v_id;
  return v_id;
end
$$;

-- migrate:down

-- Revision checks are transient observations; rolling back removes them with the operation.
delete from search.context_disclosure where operation = 'revision';

alter table search.context_disclosure
  drop constraint context_disclosure_operation_check,
  add constraint context_disclosure_operation_check check (operation in ('retrieve', 'read')),
  drop constraint context_disclosure_shape,
  add constraint context_disclosure_shape check (
    (refusal is null and corpus_digest is not null and operation = 'read'
       and object_id is not null and revision is not null and text_digest is not null
       and references_digest is null)
    or (refusal is null and corpus_digest is not null and operation = 'retrieve'
       and object_id is null and revision is null and text_digest is null
       and references_digest is not null and reference_count is not null
       and omitted_count is not null)
    or (refusal = 'KF-CTX-001' and object_id is null and revision is null and text_digest is null)
    or (refusal is not null and refusal <> 'KF-CTX-001')
  );

comment on table search.context_disclosure is
  'Transient observation (§64B, KF-SAS-RQ-219): each context-source retrieval and read, answered or '
  'refused, bound to the asker''s agent_context corpus digest, with the declared agent from the '
  'attestation. No text, no query, no person column (a pseudonymous asker key). Expires after 90 days.';

create or replace function search.record_context_disclosure(
  p_operation         text,
  p_refusal           text,
  p_corpus_digest     text,
  p_object            uuid,
  p_revision          text,
  p_text_digest       text,
  p_references_digest text,
  p_reference_count   integer,
  p_omitted_count     integer
) returns uuid
language plpgsql
security definer
set search_path = pg_catalog, core, search, content, registry
as $$
declare
  v_principal text := core.sealed_setting('kf.principal', true);
  v_org       uuid := core.current_organization();
  v_rank      integer := core.current_classification_rank();
  v_latest    text;
  v_claim     uuid;
  v_id        uuid;
begin
  if v_principal is null or v_org is null then
    raise exception 'a context disclosure is recorded only for a bound person'
      using errcode = 'insufficient_privilege';
  end if;

  if p_corpus_digest is not null then
    select m.id, m.corpus_digest into v_claim, v_latest
      from content.master_record m
      join registry.classification c on c.id = m.effective_classification
     where m.person_id = v_principal::uuid
       and m.organization_id = v_org
       and c.rank <= v_rank
     order by m.compiled_at desc, m.recorded_at desc, m.id desc
     limit 1;
    if v_latest is distinct from p_corpus_digest then
      raise exception 'corpus digest % is not the bound person''s current master record', p_corpus_digest
        using errcode = 'insufficient_privilege';
    end if;
    -- A read is bound to the claim only if the claim included that record at that revision: the
    -- record is then a member of the person's agent_context, exactly as disclosed.
    if p_operation = 'read' and p_refusal is null and not exists (
      select 1 from content.master_record_item i
       where i.master_record_id = v_claim
         and i.object_id = p_object
         and i.item_state = 'included'
         and i.content_digest = p_revision) then
      raise exception 'record % at revision % is not in the master record it is bound to',
        p_object, p_revision
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if p_refusal = 'KF-CTX-001' and p_object is not null then
    raise exception 'a record that was not found is not named'
      using errcode = 'insufficient_privilege';
  end if;

  if p_object is not null then
    if p_refusal = 'KF-CTX-002' then
      if not exists (
        select 1
          from content.master_record m
          join registry.classification c on c.id = m.effective_classification
          join content.master_record_item i on i.master_record_id = m.id
         where m.person_id = v_principal::uuid
           and m.organization_id = v_org
           and c.rank <= v_rank
           and i.object_id = p_object
           and i.item_state = 'included') then
        raise exception 'record % was never in the bound person''s master record', p_object
          using errcode = 'insufficient_privilege';
      end if;
    elsif not exists (
      select 1
        from core.object o
        join registry.classification c on c.id = o.classification
       where o.id = p_object
         and o.organization_id = v_org
         and c.rank <= v_rank) then
      raise exception 'record % is not within the bound context', p_object
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  insert into search.context_disclosure
    (organization_id, operation, refusal, corpus_digest, object_id, revision, text_digest,
     references_digest, reference_count, omitted_count, agent_participation, asker_rank, asker_key)
  values (
    v_org, p_operation, p_refusal, p_corpus_digest, p_object, p_revision, p_text_digest,
    p_references_digest, p_reference_count, p_omitted_count,
    core.sealed_setting('kf.agent_participation', true),
    v_rank,
    public.hmac(convert_to(v_principal, 'UTF8'), search.current_asker_key(), 'sha256')
  )
  returning id into v_id;
  return v_id;
end
$$;
