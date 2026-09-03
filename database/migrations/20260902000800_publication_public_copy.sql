-- migrate:up

-- ADR 0021. The publication boundary, storage side. `publish_document_view` already crosses
-- the institutional boundary: it requires an accepted, qualified compilation, an effective
-- controlled document, and a registered publication target, and the public route serves
-- only an Ed25519-signed manifest over that act. What it never did was put bytes anywhere: a
-- `public_copy` location existed as a role nothing wrote (ADR 0017).
--
-- Now a publication TARGET may name a store declared public, and the publication act writes
-- exactly one `public_copy` of the compiled view into it. Unpublishing is not a delete: when
-- the controlled document leaves `effective` — withdrawn or superseded, both acts that require
-- `act` — every public copy of its publications gets a recorded verification failure that
-- says so, the public route already refuses (it requires `effective`), and the bytes stay as
-- evidence of what was public and until when.

alter table content.artifact_store
  add column public boolean not null default false;

comment on column content.artifact_store.public is
  'ADR 0021: bytes written here are outside the product-instance boundary. Only a publication act writes into one.';

alter table content.document_publication_target
  add column public_store_id text references content.artifact_store (id) on delete restrict;

comment on column content.document_publication_target.public_store_id is
  'ADR 0021: the public store this target publishes bytes into; null means the signed public route only.';

-- A target may only name a store that is public. Checked by trigger because a CHECK cannot
-- read another table.
create or replace function content.publication_target_store_is_public() returns trigger
language plpgsql
set search_path = pg_catalog, content
as $$
declare
  v_public boolean;
begin
  if new.public_store_id is null then return new; end if;
  select s.public into v_public from content.artifact_store s where s.id = new.public_store_id;
  if v_public is distinct from true then
    raise exception 'publication target % names store %, which is not declared public',
      new.target_key, new.public_store_id using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger publication_target_store_is_public
  before insert or update on content.document_publication_target
  for each row execute function content.publication_target_store_is_public();

-- Only a publication act may create a public copy, and only into a public store. The
-- location guard (ADR 0017) already refuses deletes and non-verification updates.
create or replace function content.public_copy_by_publication_only() returns trigger
language plpgsql
set search_path = pg_catalog, content, core
as $$
declare
  v_public boolean;
  v_action_type text;
begin
  if new.role <> 'public_copy' then return new; end if;
  select s.public into v_public from content.artifact_store s where s.id = new.store_id;
  if v_public is distinct from true then
    raise exception 'a public copy may only be written into a store declared public (%)', new.store_id
      using errcode = 'check_violation';
  end if;
  select a.action_type into v_action_type from core.action a where a.id = new.recorded_by_action;
  if v_action_type is distinct from 'publish_document_view' then
    raise exception 'a public copy is written only by publish_document_view, not by %',
      coalesce(v_action_type, 'no recorded act') using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger public_copy_by_publication_only
  before insert on content.artifact_location
  for each row execute function content.public_copy_by_publication_only();

-- Unpublish = the document leaves `effective`. Every public copy of its publications is
-- marked as no longer verifiable-as-public; nothing is deleted.
create or replace function content.unpublish_on_ineffective() returns trigger
language plpgsql
set search_path = pg_catalog, content, quality, core
as $$
begin
  if new.object_type = 'controlled_document'
     and old.lifecycle_state = 'effective'
     and new.lifecycle_state <> 'effective' then
    update content.artifact_location l
       set verified_at = now(),
           verified_sha256 = null,
           verification_failure = 'unpublished: the controlled document left effective ('
                                  || new.lifecycle_state || ')',
           verified_by_action = core.current_action_id()
      from content.document_publication p
      join content.compiled_view v on v.id = p.compiled_view_id
     where p.controlled_document_id = new.id
       and l.version_id = v.artifact_version_id
       and l.role = 'public_copy'
       and l.verification_failure is null;
  end if;
  return new;
end;
$$;

create trigger unpublish_on_ineffective
  after update of lifecycle_state on core.object
  for each row execute function content.unpublish_on_ineffective();

-- migrate:down

drop trigger unpublish_on_ineffective on core.object;
drop function content.unpublish_on_ineffective();
drop trigger public_copy_by_publication_only on content.artifact_location;
drop function content.public_copy_by_publication_only();
drop trigger publication_target_store_is_public on content.document_publication_target;
drop function content.publication_target_store_is_public();
alter table content.document_publication_target drop column public_store_id;
alter table content.artifact_store drop column public;
