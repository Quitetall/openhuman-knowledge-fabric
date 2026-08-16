-- migrate:up

-- Liminal-backed document compiler authority model.
--
-- Authored source, exact revisions and compiler receipts are PostgreSQL facts. Parsed blocks,
-- semantic graphs and compiled views remain derived. Every authored subject points at exactly
-- one current Holder; changing that pointer is a typed, preconditioned action, never a period
-- where two systems are both writable.

create table content.document_subject (
  id                 uuid primary key default uuidv7(),
  object_id          uuid not null unique references core.object (id) on delete restrict,
  subject_kind       text not null check (subject_kind in ('fragment', 'composition')),
  stable_key         text not null unique check (length(btrim(stable_key)) between 1 and 240),
  document_policy    text not null
                       check (document_policy in ('ordinary', 'controlled', 'regulated')),
  current_holder_id  uuid not null,
  created_at         timestamptz not null default now(),
  created_by         uuid not null,
  created_by_action  uuid not null references core.action (id) on delete restrict,
  unique (id, subject_kind)
);

create table content.document_source_holder (
  id                         uuid primary key default uuidv7(),
  subject_id                 uuid not null references content.document_subject (id)
                               on delete restrict deferrable initially deferred,
  previous_holder_id         uuid,
  holder_kind                text not null
                               check (holder_kind in ('fabric_native', 'git', 'external')),
  fabric_artifact_version_id uuid references content.artifact_version (id) on delete restrict,
  git_repository             text,
  git_commit_sha             text,
  git_path                   text,
  git_submodule_commit_sha   text,
  external_authority         text,
  external_revision          text,
  content_digest             text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  conversion_loss            jsonb not null default '[]'::jsonb
                               check (jsonb_typeof(conversion_loss) = 'array'),
  migration_reason           text,
  reversible_migration_plan  text,
  recorded_at                timestamptz not null default now(),
  recorded_by                uuid not null,
  recorded_by_action         uuid not null references core.action (id) on delete restrict,

  constraint document_source_holder_not_self check (previous_holder_id is null or previous_holder_id <> id),
  constraint document_source_holder_one_authority check (
    (holder_kind = 'fabric_native'
      and fabric_artifact_version_id is not null
      and git_repository is null and git_commit_sha is null and git_path is null
      and git_submodule_commit_sha is null
      and external_authority is null and external_revision is null)
    or
    (holder_kind = 'git'
      and fabric_artifact_version_id is null
      and git_repository is not null and length(btrim(git_repository)) > 0
      and git_commit_sha is not null and git_commit_sha ~ '^[0-9a-f]{40}$'
      and git_path is not null and length(btrim(git_path)) > 0
      and (git_submodule_commit_sha is null or git_submodule_commit_sha ~ '^[0-9a-f]{40}$')
      and external_authority is null and external_revision is null)
    or
    (holder_kind = 'external'
      and fabric_artifact_version_id is null
      and git_repository is null and git_commit_sha is null and git_path is null
      and git_submodule_commit_sha is null
      and external_authority is not null and length(btrim(external_authority)) > 0
      and external_revision is not null and length(btrim(external_revision)) > 0)
  ),
  constraint document_source_holder_change_explained check (
    (previous_holder_id is null
      and migration_reason is null and reversible_migration_plan is null)
    or
    (previous_holder_id is not null
      and (
        (migration_reason is null and reversible_migration_plan is null)
        or
        (migration_reason is not null and length(btrim(migration_reason)) > 0
          and reversible_migration_plan is not null
          and length(btrim(reversible_migration_plan)) > 0)
      ))
  ),
  unique (subject_id, id),
  unique (subject_id, id, content_digest),
  unique (subject_id, previous_holder_id),
  constraint document_source_holder_previous
    foreign key (subject_id, previous_holder_id)
    references content.document_source_holder (subject_id, id)
    on delete restrict
);

-- SQL unique constraints admit multiple NULLs. This partial index makes one initial Holder,
-- while the unique predecessor constraint above makes every later change a linear chain.
create unique index document_source_holder_one_initial
  on content.document_source_holder (subject_id) where previous_holder_id is null;

alter table content.document_subject
  add constraint document_subject_current_holder
  foreign key (id, current_holder_id)
  references content.document_source_holder (subject_id, id)
  on delete restrict deferrable initially deferred;

create table content.authored_fragment (
  id            uuid primary key,
  subject_kind  text not null default 'fragment' check (subject_kind = 'fragment'),
  foreign key (id, subject_kind)
    references content.document_subject (id, subject_kind) on delete restrict
);

create table content.document_composition (
  id            uuid primary key,
  subject_kind  text not null default 'composition' check (subject_kind = 'composition'),
  foreign key (id, subject_kind)
    references content.document_subject (id, subject_kind) on delete restrict
);

create table content.authored_fragment_revision (
  id                    uuid primary key default uuidv7(),
  fragment_id           uuid not null references content.authored_fragment (id) on delete restrict,
  previous_revision_id  uuid,
  holder_id             uuid not null,
  media_type            text not null check (length(btrim(media_type)) > 0),
  classification        text not null references registry.classification (id),
  revision_state        text not null check (revision_state in ('draft', 'active', 'retired')),
  content_digest        text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  revision_digest       text not null unique check (revision_digest ~ '^[0-9a-f]{64}$'),
  created_at            timestamptz not null default now(),
  created_by            uuid not null,
  created_by_action     uuid not null references core.action (id) on delete restrict,

  constraint authored_fragment_revision_not_self
    check (previous_revision_id is null or previous_revision_id <> id),
  unique (fragment_id, id),
  unique (fragment_id, previous_revision_id),
  constraint authored_fragment_revision_previous
    foreign key (fragment_id, previous_revision_id)
    references content.authored_fragment_revision (fragment_id, id) on delete restrict,
  constraint authored_fragment_revision_holder
    foreign key (fragment_id, holder_id, content_digest)
    references content.document_source_holder (subject_id, id, content_digest) on delete restrict
);

create unique index authored_fragment_revision_one_initial
  on content.authored_fragment_revision (fragment_id) where previous_revision_id is null;

create table content.composition_revision (
  id                    uuid primary key default uuidv7(),
  composition_id        uuid not null references content.document_composition (id) on delete restrict,
  previous_revision_id  uuid,
  revision_digest       text not null unique check (revision_digest ~ '^[0-9a-f]{64}$'),
  created_at            timestamptz not null default now(),
  created_by            uuid not null,
  created_by_action     uuid not null references core.action (id) on delete restrict,

  constraint composition_revision_not_self
    check (previous_revision_id is null or previous_revision_id <> id),
  unique (composition_id, id),
  unique (composition_id, previous_revision_id),
  constraint composition_revision_previous
    foreign key (composition_id, previous_revision_id)
    references content.composition_revision (composition_id, id) on delete restrict
);

create unique index composition_revision_one_initial
  on content.composition_revision (composition_id) where previous_revision_id is null;

-- A binding resolves one declared type at one immutable object revision OR one snapshot.
-- It never means "whatever value is current when somebody renders this later".
create unique index document_binding_snapshot_identity on core.snapshot (object_id, id);

create table content.typed_binding (
  id                 uuid primary key default uuidv7(),
  object_id          uuid not null references core.object (id) on delete restrict,
  source_kind        text not null check (source_kind in ('object_revision', 'snapshot')),
  object_revision    bigint,
  snapshot_id        uuid,
  selector           text not null check (length(btrim(selector)) > 0),
  expected_type      text not null
                       check (expected_type in ('string', 'number', 'integer', 'boolean',
                                                'object', 'array', 'null')),
  renderer           text not null check (length(btrim(renderer)) > 0),
  resolved_value     jsonb not null,
  value_digest       text not null check (value_digest ~ '^[0-9a-f]{64}$'),
  binding_digest     text not null unique check (binding_digest ~ '^[0-9a-f]{64}$'),
  created_at         timestamptz not null default now(),
  created_by         uuid not null,
  created_by_action  uuid not null references core.action (id) on delete restrict,

  constraint typed_binding_one_source check (
    (source_kind = 'object_revision' and object_revision is not null
      and object_revision > 0 and snapshot_id is null)
    or
    (source_kind = 'snapshot' and object_revision is null and snapshot_id is not null)
  ),
  constraint typed_binding_value_type check (
    (expected_type = 'string' and jsonb_typeof(resolved_value) = 'string')
    or (expected_type = 'number' and jsonb_typeof(resolved_value) = 'number')
    or (expected_type = 'integer' and jsonb_typeof(resolved_value) = 'number'
        and trunc((resolved_value #>> '{}')::numeric) = (resolved_value #>> '{}')::numeric)
    or (expected_type = 'boolean' and jsonb_typeof(resolved_value) = 'boolean')
    or (expected_type = 'object' and jsonb_typeof(resolved_value) = 'object')
    or (expected_type = 'array' and jsonb_typeof(resolved_value) = 'array')
    or (expected_type = 'null' and jsonb_typeof(resolved_value) = 'null')
  ),
  constraint typed_binding_snapshot_object
    foreign key (object_id, snapshot_id)
    references core.snapshot (object_id, id) on delete restrict
);

create table content.composition_input (
  composition_revision_id        uuid not null
                                   references content.composition_revision (id) on delete restrict,
  ordinal                        integer not null check (ordinal > 0),
  input_role                     text not null
                                   check (input_role in ('fragment', 'composition', 'resource',
                                                        'binding', 'generated_view')),
  fragment_revision_id           uuid references content.authored_fragment_revision (id)
                                   on delete restrict,
  child_composition_revision_id  uuid references content.composition_revision (id)
                                   on delete restrict,
  resource_version_id            uuid references content.artifact_version (id) on delete restrict,
  binding_id                     uuid references content.typed_binding (id) on delete restrict,
  compiled_view_id               uuid,
  content_digest                 text check (content_digest ~ '^[0-9a-f]{64}$'),

  primary key (composition_revision_id, ordinal),
  constraint composition_input_not_self
    check (child_composition_revision_id is null
           or child_composition_revision_id <> composition_revision_id),
  constraint composition_input_one_target check (
    (input_role = 'fragment'
      and fragment_revision_id is not null
      and child_composition_revision_id is null and resource_version_id is null
      and binding_id is null and compiled_view_id is null and content_digest is null)
    or
    (input_role = 'composition'
      and child_composition_revision_id is not null
      and fragment_revision_id is null and resource_version_id is null
      and binding_id is null and compiled_view_id is null and content_digest is null)
    or
    (input_role = 'resource'
      and resource_version_id is not null and content_digest is not null
      and fragment_revision_id is null and child_composition_revision_id is null
      and binding_id is null and compiled_view_id is null)
    or
    (input_role = 'binding'
      and binding_id is not null
      and fragment_revision_id is null and child_composition_revision_id is null
      and resource_version_id is null and compiled_view_id is null and content_digest is null)
    or
    (input_role = 'generated_view'
      and compiled_view_id is not null and content_digest is not null
      and fragment_revision_id is null and child_composition_revision_id is null
      and resource_version_id is null and binding_id is null)
  )
);

create index composition_input_child
  on content.composition_input (child_composition_revision_id)
  where child_composition_revision_id is not null;

create table content.compilation_basis (
  id                            uuid primary key default uuidv7(),
  protocol                      text not null check (protocol = 'kf-document-v1'),
  root_composition_revision_id  uuid not null
                                  references content.composition_revision (id) on delete restrict,
  basis                         jsonb not null check (jsonb_typeof(basis) = 'object'),
  basis_digest                  text not null unique check (basis_digest ~ '^[0-9a-f]{64}$'),
  ontology_digest               text not null check (ontology_digest ~ '^[0-9a-f]{64}$'),
  policy_digest                 text not null check (policy_digest ~ '^[0-9a-f]{64}$'),
  target_profiles               jsonb not null
                                  check (jsonb_typeof(target_profiles) = 'array'
                                         and jsonb_array_length(target_profiles) > 0),
  compiler_kind                 text not null check (compiler_kind in ('liminal', 'in_memory')),
  compiler_name                 text not null check (length(btrim(compiler_name)) > 0),
  compiler_version              text not null check (length(btrim(compiler_version)) > 0),
  liminal_commit_sha            text,
  cargo_lock_digest             text,
  executable_digest             text not null check (executable_digest ~ '^[0-9a-f]{64}$'),
  qualification_state           text not null
                                  check (qualification_state in (
                                    'not_applicable', 'not_run', 'incomplete',
                                    'unratified', 'qualified'
                                  )),
  qualification_receipt_digest text,
  qualification_ratified       boolean not null default false,
  -- Null means staged and unusable. Only finalize_compilation_basis derives this from the
  -- complete authoritative closure; callers never choose an output classification.
  effective_classification     text references registry.classification (id),
  finalized_at                 timestamptz,
  created_at                    timestamptz not null default now(),
  created_by                    uuid not null,
  created_by_action             uuid not null references core.action (id) on delete restrict,

  constraint compilation_basis_compiler_identity check (
    (compiler_kind = 'in_memory'
      and liminal_commit_sha is null and cargo_lock_digest is null
      and qualification_state = 'not_applicable'
      and qualification_receipt_digest is null and not qualification_ratified)
    or
    (compiler_kind = 'liminal'
      and liminal_commit_sha is not null and liminal_commit_sha ~ '^[0-9a-f]{40}$'
      and cargo_lock_digest is not null and cargo_lock_digest ~ '^[0-9a-f]{64}$'
      and qualification_state <> 'not_applicable'
      and (qualification_receipt_digest is null
           or qualification_receipt_digest ~ '^[0-9a-f]{64}$')
      and ((qualification_state = 'qualified'
            and qualification_ratified and qualification_receipt_digest is not null)
           or (qualification_state <> 'qualified' and not qualification_ratified)))
  ),
  constraint compilation_basis_finalization_complete check (
    (effective_classification is null and finalized_at is null)
    or (effective_classification is not null and finalized_at is not null)
  )
);

create table content.compilation_basis_fragment (
  basis_id             uuid not null references content.compilation_basis (id) on delete restrict,
  fragment_revision_id uuid not null
                         references content.authored_fragment_revision (id) on delete restrict,
  primary key (basis_id, fragment_revision_id)
);

create table content.compilation_basis_composition (
  basis_id                uuid not null references content.compilation_basis (id) on delete restrict,
  composition_revision_id uuid not null references content.composition_revision (id) on delete restrict,
  primary key (basis_id, composition_revision_id)
);

create table content.compilation_basis_binding (
  basis_id    uuid not null references content.compilation_basis (id) on delete restrict,
  binding_id  uuid not null references content.typed_binding (id) on delete restrict,
  primary key (basis_id, binding_id)
);

create table content.compilation_run (
  id                  uuid primary key default uuidv7(),
  basis_id            uuid not null references content.compilation_basis (id) on delete restrict,
  compiler_digest     text not null check (compiler_digest ~ '^[0-9a-f]{64}$'),
  dependency_digest   text not null check (dependency_digest ~ '^[0-9a-f]{64}$'),
  run_status          text not null check (run_status in ('succeeded', 'failed')),
  draft_only          boolean not null,
  -- Filled from the finalized basis by a BEFORE INSERT trigger. Any supplied value is ignored.
  effective_classification text not null references registry.classification (id),
  semantic_digest     text check (semantic_digest ~ '^[0-9a-f]{64}$'),
  diagnostics         jsonb not null default '[]'::jsonb
                        check (jsonb_typeof(diagnostics) = 'array'),
  conversion_loss     jsonb not null default '[]'::jsonb
                        check (jsonb_typeof(conversion_loss) = 'array'),
  failure_code        text,
  failure_message     text,
  run_digest          text not null unique check (run_digest ~ '^[0-9a-f]{64}$'),
  recorded_at         timestamptz not null default now(),
  requested_by_action uuid not null references core.action (id) on delete restrict,
  recorded_by         uuid not null,

  constraint compilation_run_outcome_complete check (
    (run_status = 'succeeded'
      and semantic_digest is not null and failure_code is null and failure_message is null)
    or
    (run_status = 'failed'
      and semantic_digest is null
      and failure_code is not null and length(btrim(failure_code)) > 0
      and failure_message is not null and length(btrim(failure_message)) > 0)
  )
);

-- The artifact-version digest and compiled-view digest are the same raw byte identity.
create unique index document_compiled_artifact_digest
  on content.artifact_version (id, sha256);

alter table content.document_source_holder
  add constraint document_source_holder_fabric_digest
  foreign key (fabric_artifact_version_id, content_digest)
  references content.artifact_version (id, sha256) on delete restrict;

create table content.compiled_view (
  id                   uuid primary key default uuidv7(),
  compilation_run_id   uuid not null references content.compilation_run (id) on delete restrict,
  target               text not null check (length(btrim(target)) > 0),
  media_type           text not null check (length(btrim(media_type)) > 0),
  artifact_version_id  uuid not null,
  content_digest       text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  -- Filled from the run/basis closure by a BEFORE INSERT trigger, never by the compiler.
  effective_classification text not null references registry.classification (id),
  recorded_at          timestamptz not null default now(),
  recorded_by          uuid not null,

  unique (compilation_run_id, target),
  unique (id, content_digest),
  foreign key (artifact_version_id, content_digest)
    references content.artifact_version (id, sha256) on delete restrict
);

-- Publication destinations are administrator-registered policy facts. Application actions may
-- select one but cannot create or weaken one. Policy changes create a new versioned row; explicit
-- retirement is a separate append-only tombstone rather than a mutable active flag.
create table content.document_publication_target (
  id                   uuid primary key default uuidv7(),
  organization_id      uuid not null references org.organization (id) on delete restrict,
  target_key           text not null check (length(btrim(target_key)) between 1 and 240),
  max_classification   text not null references registry.classification (id),
  policy_digest        text not null check (policy_digest ~ '^[0-9a-f]{64}$'),
  registered_at        timestamptz not null default now(),
  registered_by        uuid not null,

  unique (organization_id, target_key, policy_digest),
  unique (organization_id, id, policy_digest)
);

create table content.document_publication_target_retirement (
  target_id          uuid primary key references content.document_publication_target (id)
                       on delete restrict,
  retired_at         timestamptz not null default now(),
  retired_by         uuid not null,
  retirement_reason text not null check (length(btrim(retirement_reason)) > 0)
);

alter table quality.controlled_document
  add constraint controlled_document_content_version_identity unique (id, content_version);

-- One immutable deployment authority receipt. It freezes the accepted compiler result, exact
-- controlled revision and the exact destination policy consulted when publication was allowed.
create table content.document_publication (
  id                                   uuid primary key default uuidv7(),
  action_id                            uuid not null unique references core.action (id)
                                           on delete restrict,
  acceptance_action_id                 uuid not null references core.action (id) on delete restrict,
  organization_id                      uuid not null references org.organization (id)
                                           on delete restrict,
  subject_id                           uuid not null references content.document_composition (id)
                                           on delete restrict,
  compiled_view_id                     uuid not null,
  compiled_view_digest                 text not null check (compiled_view_digest ~ '^[0-9a-f]{64}$'),
  controlled_document_id               uuid not null,
  controlled_content_version_id        uuid not null,
  publication_target_id                uuid not null,
  publication_target_policy_digest     text not null
                                           check (publication_target_policy_digest ~ '^[0-9a-f]{64}$'),
  effective_classification             text not null references registry.classification (id),
  published_at                         timestamptz not null default now(),
  published_by                         uuid not null,

  foreign key (compiled_view_id, compiled_view_digest)
    references content.compiled_view (id, content_digest) on delete restrict,
  foreign key (controlled_document_id, controlled_content_version_id)
    references quality.controlled_document (id, content_version) on delete restrict,
  foreign key (organization_id, publication_target_id, publication_target_policy_digest)
    references content.document_publication_target (organization_id, id, policy_digest)
    on delete restrict,
  unique (compiled_view_id, controlled_document_id, publication_target_id)
);

create table content.proposal_overlay (
  id                            uuid primary key default uuidv7(),
  subject_id                    uuid not null references content.document_subject (id)
                                  on delete restrict,
  base_fragment_revision_id     uuid,
  base_composition_revision_id  uuid,
  basis_id                      uuid not null references content.compilation_basis (id)
                                  on delete restrict,
  proposal_kind                 text not null
                                  check (proposal_kind in ('source_patch', 'semantic_operations')),
  proposed_by_kind              text not null check (proposed_by_kind in ('human', 'model')),
  actor_id                      uuid,
  model_provider                text,
  model_profile                 text,
  model_request_id              text,
  model_provenance              jsonb
                                  check (model_provenance is null
                                         or jsonb_typeof(model_provenance) = 'object'),
  operations                    jsonb not null
                                  check (jsonb_typeof(operations) = 'array'
                                         and jsonb_array_length(operations) = 1),
  proposal_digest               text not null unique check (proposal_digest ~ '^[0-9a-f]{64}$'),
  created_at                    timestamptz not null default now(),
  created_by_action             uuid not null references core.action (id) on delete restrict,

  constraint proposal_overlay_one_base check (
    (base_fragment_revision_id is not null)::integer
    + (base_composition_revision_id is not null)::integer = 1
  ),
  constraint proposal_overlay_author check (
    (proposed_by_kind = 'human'
      and actor_id is not null
      and model_provider is null and model_profile is null and model_request_id is null
      and model_provenance is null)
    or
    (proposed_by_kind = 'model'
      and actor_id is null
      and model_provider is not null and length(btrim(model_provider)) > 0
      and model_profile is not null and length(btrim(model_profile)) > 0
      and model_request_id is not null and length(btrim(model_request_id)) > 0
      and model_provenance is not null)
  ),
  foreign key (subject_id, base_fragment_revision_id)
    references content.authored_fragment_revision (fragment_id, id) on delete restrict,
  foreign key (subject_id, base_composition_revision_id)
    references content.composition_revision (composition_id, id) on delete restrict
);

-- ── invariant triggers ─────────────────────────────────────────────────────────────────

create function content.enforce_document_holder_switch() returns trigger
language plpgsql
as $$
declare
  v_action_type text;
  v_old_holder content.document_source_holder%rowtype;
  v_new_holder content.document_source_holder%rowtype;
  v_subject_organization uuid;
  v_artifact_organization uuid;
begin
  if new.id <> old.id or new.object_id <> old.object_id
     or new.subject_kind <> old.subject_kind or new.stable_key <> old.stable_key
     or new.document_policy <> old.document_policy
     or new.created_at <> old.created_at or new.created_by <> old.created_by
     or new.created_by_action <> old.created_by_action then
    raise exception 'document subject identity is immutable'
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.current_holder_id = old.current_holder_id then
    return new;
  end if;
  select * into v_old_holder
    from content.document_source_holder h where h.id = old.current_holder_id;
  select * into v_new_holder
    from content.document_source_holder h where h.id = new.current_holder_id;
  if v_new_holder.subject_id is distinct from new.id
     or v_new_holder.previous_holder_id is distinct from old.current_holder_id then
    raise exception 'new Holder must be the next immutable Holder for this subject'
      using errcode = 'integrity_constraint_violation';
  end if;
  select action_type into v_action_type
    from core.action where id = core.current_action_id();
  if v_action_type = 'change_document_source_holder' then
    if v_new_holder.migration_reason is null
       or v_new_holder.reversible_migration_plan is null then
      raise exception 'Holder authority transfer requires reason and reversible migration plan'
        using errcode = 'integrity_constraint_violation';
    end if;
    return new;
  end if;
  if v_action_type not in (
       'revise_authored_fragment', 'revise_document_composition', 'apply_document_proposal'
     ) then
    raise exception 'Holder changes require a typed transfer or authored-source revision action'
      using errcode = 'insufficient_privilege';
  end if;
  if v_new_holder.migration_reason is not null
     or v_new_holder.reversible_migration_plan is not null then
    raise exception 'source revision cannot masquerade as a Holder authority transfer'
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_new_holder.holder_kind is distinct from v_old_holder.holder_kind then
    raise exception 'source revision must remain under the current Holder authority kind'
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_new_holder.holder_kind = 'git'
     and (v_new_holder.git_repository is distinct from v_old_holder.git_repository
          or v_new_holder.git_path is distinct from v_old_holder.git_path) then
    raise exception 'Git source revision must keep repository and path; use Holder transfer'
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_new_holder.holder_kind = 'external'
     and v_new_holder.external_authority is distinct from v_old_holder.external_authority then
    raise exception 'external source revision must keep authority; use Holder transfer'
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_new_holder.holder_kind = 'fabric_native' then
    select o.organization_id into v_subject_organization
      from core.object o where o.id = new.object_id;
    select o.organization_id into v_artifact_organization
      from content.artifact_version av
      join content.artifact a on a.id = av.artifact_id
      join core.object o on o.id = a.id
     where av.id = v_new_holder.fabric_artifact_version_id;
    if v_artifact_organization is distinct from v_subject_organization then
      raise exception 'fabric-native source revision must remain in the subject organization'
        using errcode = 'integrity_constraint_violation';
    end if;
  end if;
  return new;
end
$$;

create trigger document_subject_holder_switch
  before update on content.document_subject
  for each row execute function content.enforce_document_holder_switch();

create function content.enforce_holder_switch_has_revision() returns trigger
language plpgsql
as $$
declare
  v_action_id uuid := core.current_action_id();
  v_action_type text;
begin
  if new.current_holder_id = old.current_holder_id then
    return null;
  end if;
  select action_type into v_action_type from core.action where id = v_action_id;
  if v_action_type = 'change_document_source_holder' then
    return null;
  end if;
  if new.subject_kind = 'fragment' and not exists (
    select 1 from content.authored_fragment_revision r
     where r.fragment_id = new.id
       and r.holder_id = new.current_holder_id
       and r.created_by_action = v_action_id
  ) then
    raise exception 'source Holder revision requires an authored fragment revision in the same action'
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.subject_kind = 'composition' and not exists (
    select 1 from content.composition_revision r
     where r.composition_id = new.id and r.created_by_action = v_action_id
  ) then
    raise exception 'source Holder revision requires a composition revision in the same action'
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end
$$;

create constraint trigger document_subject_holder_revision_complete
  after update on content.document_subject
  deferrable initially deferred
  for each row execute function content.enforce_holder_switch_has_revision();

create trigger document_subject_no_delete
  before delete or truncate on content.document_subject
  for each statement execute function core.refuse_mutation();

-- Exact source revisions and the mutable current-Holder pointer must move together. The
-- immediate scope gate prevents an under-classified or cross-organization native artifact;
-- the deferred gate permits either insert/update order while refusing a dangling pointer at
-- commit.
create function content.enforce_fragment_revision_holder_scope() returns trigger
language plpgsql
as $$
declare
  v_holder_kind text;
  v_subject_organization uuid;
  v_artifact_organization uuid;
  v_fragment_rank integer;
  v_artifact_rank integer;
begin
  select h.holder_kind, subject_object.organization_id,
         artifact_object.organization_id, fragment_class.rank, artifact_class.rank
    into v_holder_kind, v_subject_organization, v_artifact_organization,
         v_fragment_rank, v_artifact_rank
    from content.document_source_holder h
    join content.document_subject s on s.id = h.subject_id
    join core.object subject_object on subject_object.id = s.object_id
    join registry.classification fragment_class on fragment_class.id = new.classification
    left join content.artifact_version av on av.id = h.fabric_artifact_version_id
    left join content.artifact a on a.id = av.artifact_id
    left join core.object artifact_object on artifact_object.id = a.id
    left join registry.classification artifact_class
      on artifact_class.id = artifact_object.classification
   where h.id = new.holder_id and h.subject_id = new.fragment_id;
  if not found then
    raise exception 'fragment revision requires an exact Holder for the same subject'
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_holder_kind = 'fabric_native'
     and (v_artifact_organization is distinct from v_subject_organization
          or v_artifact_rank is null or v_artifact_rank > v_fragment_rank) then
    raise exception 'fabric-native source artifact exceeds fragment organization or classification'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

create trigger authored_fragment_revision_holder_scope
  before insert on content.authored_fragment_revision
  for each row execute function content.enforce_fragment_revision_holder_scope();

create function content.enforce_fragment_revision_is_current_holder() returns trigger
language plpgsql
as $$
declare v_current_holder uuid;
begin
  select current_holder_id into v_current_holder
    from content.document_subject where id = new.fragment_id;
  if v_current_holder is distinct from new.holder_id then
    raise exception 'new fragment revision must become the subject current Holder atomically'
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end
$$;

create constraint trigger authored_fragment_revision_current_holder
  after insert on content.authored_fragment_revision
  deferrable initially deferred
  for each row execute function content.enforce_fragment_revision_is_current_holder();

create function content.refuse_composition_cycle() returns trigger
language plpgsql
as $$
begin
  if new.child_composition_revision_id is null then
    return new;
  end if;
  if exists (
    with recursive descendants(id) as (
      select new.child_composition_revision_id
      union
      select i.child_composition_revision_id
        from content.composition_input i
        join descendants d on d.id = i.composition_revision_id
       where i.child_composition_revision_id is not null
    )
    select 1 from descendants where id = new.composition_revision_id
  ) then
    raise exception 'composition revision cycle is not permitted'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

create trigger composition_input_acyclic
  before insert on content.composition_input
  for each row execute function content.refuse_composition_cycle();

create function content.enforce_contiguous_composition_order() returns trigger
language plpgsql
as $$
declare
  v_count bigint;
  v_min integer;
  v_max integer;
begin
  select count(*), min(ordinal), max(ordinal)
    into v_count, v_min, v_max
    from content.composition_input
   where composition_revision_id = new.composition_revision_id;
  if v_count > 0 and (v_min <> 1 or v_max <> v_count) then
    raise exception 'composition ordinals must be contiguous from 1'
      using errcode = 'integrity_constraint_violation';
  end if;
  return null;
end
$$;

create constraint trigger composition_input_contiguous
  after insert on content.composition_input
  deferrable initially deferred
  for each row execute function content.enforce_contiguous_composition_order();

-- Composition revisions are assembled from append-only input rows. Once any finalized basis
-- cites a revision, another input would mutate that frozen basis without changing its digest.
create function content.refuse_finalized_composition_input() returns trigger
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended('kf-document-composition:' || new.composition_revision_id::text, 0)
  );
  if exists (
    select 1
      from content.compilation_basis_composition bc
      join content.compilation_basis b on b.id = bc.basis_id
     where bc.composition_revision_id = new.composition_revision_id
       and b.finalized_at is not null
  ) then
    raise exception 'cannot add an input to a composition revision in a finalized basis'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

create trigger composition_input_not_after_basis
  before insert on content.composition_input
  for each row execute function content.refuse_finalized_composition_input();

create function content.refuse_finalized_basis_member() returns trigger
language plpgsql
as $$
declare v_finalized_at timestamptz;
begin
  select finalized_at into v_finalized_at
    from content.compilation_basis where id = new.basis_id;
  if not found then
    raise exception 'compilation basis does not exist or is not visible'
      using errcode = 'foreign_key_violation';
  end if;
  if v_finalized_at is not null then
    raise exception 'a finalized compilation basis cannot gain members'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

create trigger compilation_basis_fragment_staged_only
  before insert on content.compilation_basis_fragment
  for each row execute function content.refuse_finalized_basis_member();
create trigger compilation_basis_composition_staged_only
  before insert on content.compilation_basis_composition
  for each row execute function content.refuse_finalized_basis_member();
create trigger compilation_basis_binding_staged_only
  before insert on content.compilation_basis_binding
  for each row execute function content.refuse_finalized_basis_member();

-- UPDATE is forbidden except for the one null -> derived finalization transition performed by
-- finalize_compilation_basis(). The GUC is not authority by itself: application roles have no
-- UPDATE grant on this table.
create function content.enforce_compilation_basis_finalization() returns trigger
language plpgsql
as $$
begin
  if current_setting('kf.document_basis_finalizing', true) is distinct from '1'
     or old.finalized_at is not null
     or new.finalized_at is null
     or new.effective_classification is null
     or (to_jsonb(new) - 'effective_classification' - 'finalized_at')
        is distinct from
        (to_jsonb(old) - 'effective_classification' - 'finalized_at') then
    raise exception 'compilation basis is immutable except for authoritative finalization'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

create trigger compilation_basis_finalize_only
  before update on content.compilation_basis
  for each row execute function content.enforce_compilation_basis_finalization();

-- Ephemeral, ungranted capability used only while authoritative classification runs. A custom
-- GUC alone is caller-forgeable; matching an unguessable per-transaction lease prevents a
-- caller from activating classifier RLS policies around some unrelated SECURITY DEFINER query.
create table content.document_basis_classifier_lease (
  backend_pid     integer not null,
  transaction_id xid8 not null,
  token           uuid not null,
  primary key (backend_pid, transaction_id, token)
);
revoke all on content.document_basis_classifier_lease from public,
  kf_app, kf_worker, kf_checkpoint, kf_readonly, kf_auditor, kf_backup;

/*
 * Close, authorize and classify one staged basis.
 *
 * SECURITY DEFINER plus classifier-only SELECT policies let this function inspect every
 * referenced row instead of silently deriving a lower maximum from RLS-hidden inputs.
 * Explicit organization and clearance checks then fail closed before visibility. Search path
 * is pinned, and classifier policies cannot activate when current_user = session_user.
 */
create function content.finalize_compilation_basis(p_basis_id uuid) returns text
language plpgsql
security definer
set search_path = pg_catalog, content, core, registry
as $$
declare
  v_basis content.compilation_basis%rowtype;
  v_root_organization uuid;
  v_expected_compositions uuid[];
  v_stable_compositions uuid[];
  v_actual_compositions uuid[];
  v_expected_fragments uuid[];
  v_actual_fragments uuid[];
  v_expected_bindings uuid[];
  v_actual_bindings uuid[];
  v_lock_id uuid;
  v_effective_classification text;
  v_max_rank integer;
  v_same_organization boolean;
  v_classifier_token uuid := uuidv7();
begin
  select * into v_basis
    from content.compilation_basis
   where id = p_basis_id
   for update;
  if not found then
    raise exception 'compilation basis does not exist'
      using errcode = 'no_data_found';
  end if;
  if v_basis.finalized_at is not null then
    raise exception 'compilation basis is already finalized'
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_basis.created_by is distinct from core.current_actor() then
    raise exception 'only the actor who staged a compilation basis may finalize it'
      using errcode = 'insufficient_privilege';
  end if;

  insert into content.document_basis_classifier_lease (backend_pid, transaction_id, token)
  values (pg_backend_pid(), pg_current_xact_id(), v_classifier_token);
  perform set_config('kf.document_basis_classifying', v_classifier_token::text, true);

  select o.organization_id into v_root_organization
    from content.composition_revision r
    join content.document_composition c on c.id = r.composition_id
    join content.document_subject s on s.id = c.id
    join core.object o on o.id = s.object_id
   where r.id = v_basis.root_composition_revision_id;
  if not found then
    raise exception 'root composition authority cannot be resolved'
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_root_organization is distinct from core.current_organization() then
    raise exception 'compilation basis crosses the active organization boundary'
      using errcode = 'insufficient_privilege';
  end if;

  -- Lock every discovered composition in sorted order, then re-read until closure is stable.
  -- Input inserts take the same advisory lock, closing the append-vs-finalize race.
  loop
    with recursive reachable(id) as (
      select v_basis.root_composition_revision_id
      union
      select i.child_composition_revision_id
        from reachable r
        join content.composition_input i on i.composition_revision_id = r.id
       where i.child_composition_revision_id is not null
    )
    select coalesce(array_agg(id order by id), array[]::uuid[])
      into v_expected_compositions from reachable;

    foreach v_lock_id in array v_expected_compositions loop
      perform pg_advisory_xact_lock(
        hashtextextended('kf-document-composition:' || v_lock_id::text, 0)
      );
    end loop;

    with recursive reachable(id) as (
      select v_basis.root_composition_revision_id
      union
      select i.child_composition_revision_id
        from reachable r
        join content.composition_input i on i.composition_revision_id = r.id
       where i.child_composition_revision_id is not null
    )
    select coalesce(array_agg(id order by id), array[]::uuid[])
      into v_stable_compositions from reachable;
    exit when v_stable_compositions = v_expected_compositions;
  end loop;

  select coalesce(array_agg(composition_revision_id order by composition_revision_id),
                  array[]::uuid[])
    into v_actual_compositions
    from content.compilation_basis_composition where basis_id = p_basis_id;
  if v_actual_compositions is distinct from v_expected_compositions then
    raise exception 'basis composition members do not equal the transitive composition closure'
      using errcode = 'integrity_constraint_violation';
  end if;

  with expected as (
    select distinct i.fragment_revision_id as id
      from content.composition_input i
     where i.composition_revision_id = any(v_expected_compositions)
       and i.fragment_revision_id is not null
  )
  select coalesce(array_agg(id order by id), array[]::uuid[])
    into v_expected_fragments from expected;
  select coalesce(array_agg(fragment_revision_id order by fragment_revision_id),
                  array[]::uuid[])
    into v_actual_fragments
    from content.compilation_basis_fragment where basis_id = p_basis_id;
  if v_actual_fragments is distinct from v_expected_fragments then
    raise exception 'basis fragment members do not equal the transitive fragment closure'
      using errcode = 'integrity_constraint_violation';
  end if;

  with expected as (
    select distinct i.binding_id as id
      from content.composition_input i
     where i.composition_revision_id = any(v_expected_compositions)
       and i.binding_id is not null
  )
  select coalesce(array_agg(id order by id), array[]::uuid[])
    into v_expected_bindings from expected;
  select coalesce(array_agg(binding_id order by binding_id), array[]::uuid[])
    into v_actual_bindings
    from content.compilation_basis_binding where basis_id = p_basis_id;
  if v_actual_bindings is distinct from v_expected_bindings then
    raise exception 'basis binding members do not equal the transitive binding closure'
      using errcode = 'integrity_constraint_violation';
  end if;

  if exists (
    select 1
      from content.composition_revision r
      left join lateral (
        select count(*)::integer as n, min(ordinal) as first_ordinal, max(ordinal) as last_ordinal
          from content.composition_input i where i.composition_revision_id = r.id
      ) ordering on true
     where r.id = any(v_expected_compositions)
       and ordering.n > 0
       and (ordering.first_ordinal <> 1 or ordering.last_ordinal <> ordering.n)
  ) then
    raise exception 'basis contains a composition whose input order is incomplete'
      using errcode = 'integrity_constraint_violation';
  end if;

  with recursive reachable(id) as (
    select v_basis.root_composition_revision_id
    union
    select i.child_composition_revision_id
      from reachable r
      join content.composition_input i on i.composition_revision_id = r.id
     where i.child_composition_revision_id is not null
  ), classification_sources(classification, organization_id) as (
    -- Root and child composition authority envelopes.
    select o.classification, o.organization_id
      from reachable q
      join content.composition_revision r on r.id = q.id
      join content.document_composition c on c.id = r.composition_id
      join content.document_subject s on s.id = c.id
      join core.object o on o.id = s.object_id
    union all
    -- Authored revision classification, scoped by its fragment authority envelope.
    select r.classification, o.organization_id
      from unnest(v_expected_fragments) expected(id)
      join content.authored_fragment_revision r on r.id = expected.id
      join content.document_subject s on s.id = r.fragment_id
      join core.object o on o.id = s.object_id
    union all
    -- Fabric-native fragment bytes can be more restricted than their revision declaration.
    select o.classification, o.organization_id
      from unnest(v_expected_fragments) expected(id)
      join content.authored_fragment_revision r on r.id = expected.id
      join content.document_source_holder h on h.id = r.holder_id
      join content.artifact_version av on av.id = h.fabric_artifact_version_id
      join content.artifact a on a.id = av.artifact_id
      join core.object o on o.id = a.id
     where h.holder_kind = 'fabric_native'
    union all
    -- Resource artifact authority envelopes.
    select o.classification, o.organization_id
      from content.composition_input i
      join content.artifact_version av on av.id = i.resource_version_id
      join content.artifact a on a.id = av.artifact_id
      join core.object o on o.id = a.id
     where i.composition_revision_id = any(v_expected_compositions)
       and i.input_role = 'resource'
    union all
    -- Exact object revision or snapshot behind every typed binding.
    select o.classification, o.organization_id
      from unnest(v_expected_bindings) expected(id)
      join content.typed_binding b on b.id = expected.id
      join core.object o on o.id = b.object_id
    union all
    -- Prior generated views already carry their own frozen transitive maximum.
    select v.effective_classification, o.organization_id
      from content.composition_input i
      join content.compiled_view v on v.id = i.compiled_view_id
      join content.artifact_version av on av.id = v.artifact_version_id
      join content.artifact a on a.id = av.artifact_id
      join core.object o on o.id = a.id
     where i.composition_revision_id = any(v_expected_compositions)
       and i.input_role = 'generated_view'
  )
  select (array_agg(s.classification order by c.rank desc, s.classification))[1],
         max(c.rank), bool_and(s.organization_id = v_root_organization)
    into v_effective_classification, v_max_rank, v_same_organization
    from classification_sources s
    join registry.classification c on c.id = s.classification;

  if v_effective_classification is null or not coalesce(v_same_organization, false) then
    raise exception 'basis authority closure is incomplete or crosses organizations'
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_max_rank > core.current_classification_rank() then
    raise exception 'basis classification exceeds the active clearance'
      using errcode = 'insufficient_privilege';
  end if;

  perform set_config('kf.document_basis_finalizing', '1', true);
  update content.compilation_basis
     set effective_classification = v_effective_classification,
         finalized_at = clock_timestamp()
   where id = p_basis_id;
  delete from content.document_basis_classifier_lease
   where backend_pid = pg_backend_pid()
     and transaction_id = pg_current_xact_id()
     and token = v_classifier_token;
  perform set_config('kf.document_basis_classifying', '', true);
  perform set_config('kf.document_basis_finalizing', '', true);
  return v_effective_classification;
end
$$;

create function content.enforce_compilation_run_qualification() returns trigger
language plpgsql
as $$
declare
  v_draft_only boolean;
  v_effective_classification text;
  v_finalized_at timestamptz;
begin
  select b.compiler_kind <> 'liminal'
         or b.qualification_state <> 'qualified'
         or not b.qualification_ratified
         or b.qualification_receipt_digest is null,
         b.effective_classification,
         b.finalized_at
    into v_draft_only, v_effective_classification, v_finalized_at
    from content.compilation_basis b
   where b.id = new.basis_id;
  if not found or v_finalized_at is null or v_effective_classification is null then
    raise exception 'compilation runs require a complete finalized basis'
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_draft_only is distinct from new.draft_only then
    raise exception 'compilation run draft_only does not match its compiler qualification'
      using errcode = 'integrity_constraint_violation';
  end if;
  new.effective_classification := v_effective_classification;
  return new;
end
$$;

-- Worker may materialize a run only for exact Basis authorized by recorded request action.
-- Acceptance code repeats this check for defense in depth, but malformed worker SQL must fail
-- before it can create a receipt that looks eligible for review.
create function content.enforce_compilation_run_request() returns trigger
language plpgsql
as $$
declare
  v_basis_action uuid;
  v_basis_digest text;
  v_target_object uuid;
  v_action_type text;
  v_action_targets uuid[];
  v_action_parameters jsonb;
begin
  if core.current_action_id() is distinct from new.requested_by_action then
    raise exception 'compilation run requested_by_action must equal the active transaction action'
      using errcode = 'insufficient_privilege';
  end if;
  select b.created_by_action, b.basis_digest, s.object_id
    into v_basis_action, v_basis_digest, v_target_object
    from content.compilation_basis b
    join content.composition_revision cr on cr.id = b.root_composition_revision_id
    join content.document_subject s on s.id = cr.composition_id
   where b.id = new.basis_id;
  select a.action_type, a.target_ids, a.parameters
    into v_action_type, v_action_targets, v_action_parameters
    from core.action a where a.id = new.requested_by_action;
  if v_basis_action is distinct from new.requested_by_action
     or v_action_type is distinct from 'request_document_compilation'
     or cardinality(v_action_targets) <> 1
     or v_action_targets[1] is distinct from v_target_object
     or v_action_parameters ->> 'basis_id' is distinct from new.basis_id::text
     or v_action_parameters -> 'basis' ->> 'basisDigest' is distinct from v_basis_digest then
    raise exception 'compilation run is not authorized by the exact recorded Basis request'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

create trigger compilation_run_request_authority
  before insert on content.compilation_run
  for each row execute function content.enforce_compilation_run_request();

create trigger compilation_run_qualification
  before insert on content.compilation_run
  for each row execute function content.enforce_compilation_run_qualification();

create function content.refuse_partial_compiled_view() returns trigger
language plpgsql
as $$
declare
  v_effective_classification text;
  v_basis_rank integer;
  v_artifact_rank integer;
  v_basis_organization uuid;
  v_artifact_organization uuid;
begin
  select r.effective_classification, basis_classification.rank, artifact_classification.rank,
         root_object.organization_id, artifact_object.organization_id
    into v_effective_classification, v_basis_rank, v_artifact_rank,
         v_basis_organization, v_artifact_organization
    from content.compilation_run r
    join content.compilation_basis b on b.id = r.basis_id
    join registry.classification basis_classification
      on basis_classification.id = r.effective_classification
    join content.composition_revision root_revision
      on root_revision.id = b.root_composition_revision_id
    join content.document_composition root_composition
      on root_composition.id = root_revision.composition_id
    join content.document_subject root_subject on root_subject.id = root_composition.id
    join core.object root_object on root_object.id = root_subject.object_id
    join content.artifact_version av on av.id = new.artifact_version_id
    join content.artifact a on a.id = av.artifact_id
    join core.object artifact_object on artifact_object.id = a.id
    join registry.classification artifact_classification
      on artifact_classification.id = artifact_object.classification
   where r.id = new.compilation_run_id and r.run_status = 'succeeded';
  if not found then
    raise exception 'compiled views require a succeeded compilation run'
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_artifact_organization is distinct from v_basis_organization then
    raise exception 'compiled view artifact must remain in the basis organization'
      using errcode = 'integrity_constraint_violation';
  end if;
  if v_artifact_rank < v_basis_rank then
    raise exception 'compiled view artifact classification is below the basis maximum'
      using errcode = 'integrity_constraint_violation';
  end if;
  new.effective_classification := v_effective_classification;
  return new;
end
$$;

create trigger compiled_view_success_only
  before insert on content.compiled_view
  for each row execute function content.refuse_partial_compiled_view();

-- Retirement and publication serialize on the immutable target row. Without this shared lock,
-- two READ COMMITTED transactions can both validate before either sees the other's insert.
create function content.lock_document_publication_target(p_target_id uuid) returns void
language plpgsql
security definer
set search_path = pg_catalog, content
as $$
begin
  perform 1
    from content.document_publication_target target
   where target.id = p_target_id
     for update;
  if not found then
    raise exception 'publication target does not exist'
      using errcode = 'foreign_key_violation';
  end if;
end
$$;
revoke all on function content.lock_document_publication_target(uuid) from public;
grant execute on function content.lock_document_publication_target(uuid) to kf_app;

create function content.lock_document_publication_target_retirement() returns trigger
language plpgsql
as $$
begin
  perform content.lock_document_publication_target(new.target_id);
  return new;
end
$$;

create trigger document_publication_target_retirement_lock
  before insert on content.document_publication_target_retirement
  for each row execute function content.lock_document_publication_target_retirement();

create function content.enforce_document_publication() returns trigger
language plpgsql
as $$
declare
  v_action_type text;
  v_action_actor uuid;
  v_action_targets uuid[];
  v_action_parameters jsonb;
  v_acceptance_type text;
  v_acceptance_targets uuid[];
  v_acceptance_parameters jsonb;
  v_view_artifact uuid;
  v_view_digest text;
  v_view_classification text;
  v_view_rank integer;
  v_run_id uuid;
  v_run_digest text;
  v_run_status text;
  v_draft_only boolean;
  v_subject_organization uuid;
  v_controlled_content uuid;
  v_controlled_state text;
  v_controlled_organization uuid;
  v_controlled_rank integer;
  v_target_organization uuid;
  v_target_policy_digest text;
  v_target_rank integer;
begin
  select a.action_type, a.actor_id, a.target_ids, a.parameters
    into v_action_type, v_action_actor, v_action_targets, v_action_parameters
    from core.action a where a.id = new.action_id;
  if core.current_action_id() is distinct from new.action_id
     or v_action_type is distinct from 'publish_document_view'
     or cardinality(v_action_targets) <> 1
     or v_action_targets[1] is distinct from new.subject_id
     or v_action_actor is distinct from new.published_by then
    raise exception 'publication receipt requires the active publish_document_view action'
      using errcode = 'insufficient_privilege';
  end if;
  if v_action_parameters ->> 'compiled_view_id' is distinct from new.compiled_view_id::text
     or v_action_parameters ->> 'compiled_view_digest'
          is distinct from new.compiled_view_digest
     or v_action_parameters ->> 'acceptance_action_id'
          is distinct from new.acceptance_action_id::text
     or v_action_parameters ->> 'controlled_document_id'
          is distinct from new.controlled_document_id::text
     or v_action_parameters ->> 'controlled_content_version_id'
          is distinct from new.controlled_content_version_id::text
     or v_action_parameters ->> 'publication_target_id'
          is distinct from new.publication_target_id::text then
    raise exception 'publication receipt does not match its recorded action parameters'
      using errcode = 'integrity_constraint_violation';
  end if;

  perform content.lock_document_publication_target(new.publication_target_id);

  select v.artifact_version_id, v.content_digest, v.effective_classification,
         view_class.rank, r.id, r.run_digest, r.run_status, r.draft_only,
         subject_object.organization_id
    into v_view_artifact, v_view_digest, v_view_classification, v_view_rank,
         v_run_id, v_run_digest, v_run_status, v_draft_only, v_subject_organization
    from content.compiled_view v
    join registry.classification view_class on view_class.id = v.effective_classification
    join content.compilation_run r on r.id = v.compilation_run_id
    join content.compilation_basis b on b.id = r.basis_id
    join content.composition_revision cr on cr.id = b.root_composition_revision_id
    join content.document_subject s on s.id = cr.composition_id
    join core.object subject_object on subject_object.id = s.object_id
   where v.id = new.compiled_view_id and s.id = new.subject_id;
  if not found or v_run_status <> 'succeeded' or v_draft_only then
    raise exception 'publication requires a qualified succeeded view for the exact subject'
      using errcode = 'integrity_constraint_violation';
  end if;

  select a.action_type, a.target_ids, a.parameters
    into v_acceptance_type, v_acceptance_targets, v_acceptance_parameters
    from core.action a where a.id = new.acceptance_action_id;
  if v_acceptance_type is distinct from 'accept_document_compilation'
     or cardinality(v_acceptance_targets) <> 1
     or v_acceptance_targets[1] is distinct from new.subject_id
     or v_acceptance_parameters ->> 'run_id' is distinct from v_run_id::text
     or v_acceptance_parameters ->> 'run_digest' is distinct from v_run_digest then
    raise exception 'publication requires the exact compilation acceptance action'
      using errcode = 'integrity_constraint_violation';
  end if;

  select cd.content_version, o.lifecycle_state, o.organization_id, controlled_class.rank
    into v_controlled_content, v_controlled_state, v_controlled_organization, v_controlled_rank
    from quality.controlled_document cd
    join core.object o on o.id = cd.id
    join registry.classification controlled_class on controlled_class.id = o.classification
   where cd.id = new.controlled_document_id
     for share of o;
  if not found or v_controlled_state <> 'effective'
     or v_controlled_content is distinct from new.controlled_content_version_id
     or v_controlled_content is distinct from v_view_artifact
     or v_controlled_rank < v_view_rank then
    raise exception 'publication requires an effective controlled revision for the exact view bytes'
      using errcode = 'integrity_constraint_violation';
  end if;

  select t.organization_id, t.policy_digest, target_class.rank
    into v_target_organization, v_target_policy_digest, v_target_rank
    from content.document_publication_target t
    join registry.classification target_class on target_class.id = t.max_classification
   where t.id = new.publication_target_id
     and not exists (
       select 1 from content.document_publication_target_retirement retired
        where retired.target_id = t.id
     );
  if not found or v_target_rank < v_view_rank then
    raise exception 'publication destination is unavailable or below the view classification'
      using errcode = 'integrity_constraint_violation';
  end if;

  if new.organization_id is distinct from v_subject_organization
     or new.organization_id is distinct from v_controlled_organization
     or new.organization_id is distinct from v_target_organization
     or new.organization_id is distinct from core.current_organization()
     or new.compiled_view_digest is distinct from v_view_digest
     or new.publication_target_policy_digest is distinct from v_target_policy_digest
     or new.effective_classification is distinct from v_view_classification then
    raise exception 'publication receipt does not equal its authoritative organization and policy facts'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

create trigger document_publication_authority
  before insert on content.document_publication
  for each row execute function content.enforce_document_publication();

-- A later artifact-envelope downgrade must not invalidate an already frozen view guarantee.
create function content.refuse_compiled_artifact_classification_downgrade() returns trigger
language plpgsql
as $$
begin
  if new.classification <> old.classification and exists (
    select 1
      from content.artifact a
      join content.artifact_version av on av.artifact_id = a.id
      join content.compiled_view v on v.artifact_version_id = av.id
      join registry.classification required on required.id = v.effective_classification
      join registry.classification proposed on proposed.id = new.classification
     where a.id = new.id and proposed.rank < required.rank
  ) then
    raise exception 'artifact classification cannot be lowered below a compiled view maximum'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end
$$;

create trigger core_object_compiled_artifact_classification
  before update of classification on core.object
  for each row execute function content.refuse_compiled_artifact_classification_downgrade();

-- All revision, edge, binding, basis, receipt, view and proposal rows are immutable. A new
-- source revision or compiler run is an INSERT, never an UPDATE of what somebody reviewed.
create trigger document_source_holder_append_only
  before update or delete or truncate on content.document_source_holder
  for each statement execute function core.refuse_mutation();
create trigger authored_fragment_append_only
  before update or delete or truncate on content.authored_fragment
  for each statement execute function core.refuse_mutation();
create trigger document_composition_append_only
  before update or delete or truncate on content.document_composition
  for each statement execute function core.refuse_mutation();
create trigger authored_fragment_revision_append_only
  before update or delete or truncate on content.authored_fragment_revision
  for each statement execute function core.refuse_mutation();
create trigger composition_revision_append_only
  before update or delete or truncate on content.composition_revision
  for each statement execute function core.refuse_mutation();
create trigger composition_input_append_only
  before update or delete or truncate on content.composition_input
  for each statement execute function core.refuse_mutation();
create trigger typed_binding_append_only
  before update or delete or truncate on content.typed_binding
  for each statement execute function core.refuse_mutation();
create trigger compilation_basis_append_only
  before delete or truncate on content.compilation_basis
  for each statement execute function core.refuse_mutation();
create trigger compilation_basis_fragment_append_only
  before update or delete or truncate on content.compilation_basis_fragment
  for each statement execute function core.refuse_mutation();
create trigger compilation_basis_composition_append_only
  before update or delete or truncate on content.compilation_basis_composition
  for each statement execute function core.refuse_mutation();
create trigger compilation_basis_binding_append_only
  before update or delete or truncate on content.compilation_basis_binding
  for each statement execute function core.refuse_mutation();
create trigger compilation_run_append_only
  before update or delete or truncate on content.compilation_run
  for each statement execute function core.refuse_mutation();
create trigger compiled_view_append_only
  before update or delete or truncate on content.compiled_view
  for each statement execute function core.refuse_mutation();
create trigger proposal_overlay_append_only
  before update or delete or truncate on content.proposal_overlay
  for each statement execute function core.refuse_mutation();
create trigger document_publication_target_append_only
  before update or delete or truncate on content.document_publication_target
  for each statement execute function core.refuse_mutation();
create trigger document_publication_target_retirement_append_only
  before update or delete or truncate on content.document_publication_target_retirement
  for each statement execute function core.refuse_mutation();
create trigger document_publication_append_only
  before update or delete or truncate on content.document_publication
  for each statement execute function core.refuse_mutation();

alter table content.composition_input
  add constraint composition_input_resource_digest
  foreign key (resource_version_id, content_digest)
  references content.artifact_version (id, sha256) on delete restrict;

alter table content.composition_input
  add constraint composition_input_generated_view_digest
  foreign key (compiled_view_id, content_digest)
  references content.compiled_view (id, content_digest) on delete restrict;

-- ── subject-scoped row security ────────────────────────────────────────────────────────

alter table content.document_subject enable row level security;
alter table content.document_subject force row level security;
alter table content.document_source_holder enable row level security;
alter table content.document_source_holder force row level security;
alter table content.authored_fragment enable row level security;
alter table content.authored_fragment force row level security;
alter table content.document_composition enable row level security;
alter table content.document_composition force row level security;
alter table content.authored_fragment_revision enable row level security;
alter table content.authored_fragment_revision force row level security;
alter table content.composition_revision enable row level security;
alter table content.composition_revision force row level security;
alter table content.typed_binding enable row level security;
alter table content.typed_binding force row level security;
alter table content.composition_input enable row level security;
alter table content.composition_input force row level security;
alter table content.compilation_basis enable row level security;
alter table content.compilation_basis force row level security;
alter table content.compilation_basis_fragment enable row level security;
alter table content.compilation_basis_fragment force row level security;
alter table content.compilation_basis_composition enable row level security;
alter table content.compilation_basis_composition force row level security;
alter table content.compilation_basis_binding enable row level security;
alter table content.compilation_basis_binding force row level security;
alter table content.compilation_run enable row level security;
alter table content.compilation_run force row level security;
alter table content.compiled_view enable row level security;
alter table content.compiled_view force row level security;
alter table content.proposal_overlay enable row level security;
alter table content.proposal_overlay force row level security;
alter table content.document_publication enable row level security;
alter table content.document_publication force row level security;
alter table content.document_publication_target enable row level security;
alter table content.document_publication_target force row level security;
alter table content.document_publication_target_retirement enable row level security;
alter table content.document_publication_target_retirement force row level security;

create function content.document_basis_classifier_active() returns boolean
language sql stable
security definer
set search_path = pg_catalog, content
as $$
  select current_user <> session_user and exists (
    select 1 from content.document_basis_classifier_lease l
     where l.backend_pid = pg_backend_pid()
       and l.transaction_id = pg_current_xact_id()
       and l.token::text = nullif(current_setting('kf.document_basis_classifying', true), '')
  )
$$;

-- Narrow SELECT-only escape hatch for authoritative closure calculation. A caller setting the
-- custom GUC directly keeps current_user = session_user and gains nothing. Only a
-- SECURITY DEFINER boundary can activate these policies; finalize_compilation_basis is the one
-- such boundary granted to the application role.
create policy object_document_basis_classifier on core.object
  for select using (content.document_basis_classifier_active());
create policy document_subject_classifier on content.document_subject
  for select using (content.document_basis_classifier_active());
create policy document_source_holder_classifier on content.document_source_holder
  for select using (content.document_basis_classifier_active());
create policy authored_fragment_classifier on content.authored_fragment
  for select using (content.document_basis_classifier_active());
create policy document_composition_classifier on content.document_composition
  for select using (content.document_basis_classifier_active());
create policy authored_fragment_revision_classifier on content.authored_fragment_revision
  for select using (content.document_basis_classifier_active());
create policy composition_revision_classifier on content.composition_revision
  for select using (content.document_basis_classifier_active());
create policy typed_binding_classifier on content.typed_binding
  for select using (content.document_basis_classifier_active());
create policy composition_input_classifier on content.composition_input
  for select using (content.document_basis_classifier_active());
create policy compilation_basis_classifier on content.compilation_basis
  for select using (content.document_basis_classifier_active());
create policy compilation_run_classifier on content.compilation_run
  for select using (content.document_basis_classifier_active());
create policy compiled_view_classifier on content.compiled_view
  for select using (content.document_basis_classifier_active());
create policy document_publication_classifier on content.document_publication
  for select using (content.document_basis_classifier_active());
create policy document_publication_target_classifier on content.document_publication_target
  for select using (content.document_basis_classifier_active());

create policy document_subject_scope on content.document_subject
  for all
  using (exists (select 1 from core.object o where o.id = document_subject.object_id))
  with check (exists (select 1 from core.object o where o.id = document_subject.object_id));

create policy document_source_holder_scope on content.document_source_holder
  for all
  using (
    exists (select 1 from content.document_subject s where s.id = subject_id)
    and (holder_kind <> 'fabric_native' or exists (
      select 1
        from content.artifact_version av
        join content.artifact a on a.id = av.artifact_id
        join core.object o on o.id = a.id
       where av.id = fabric_artifact_version_id
    ))
  )
  with check (
    exists (select 1 from content.document_subject s where s.id = subject_id)
    and (holder_kind <> 'fabric_native' or exists (
      select 1
        from content.artifact_version av
        join content.artifact a on a.id = av.artifact_id
        join core.object o on o.id = a.id
       where av.id = fabric_artifact_version_id
    ))
  );

create policy authored_fragment_scope on content.authored_fragment
  for all
  using (exists (select 1 from content.document_subject s where s.id = authored_fragment.id))
  with check (exists (select 1 from content.document_subject s where s.id = authored_fragment.id));

create policy document_composition_scope on content.document_composition
  for all
  using (exists (select 1 from content.document_subject s where s.id = document_composition.id))
  with check (exists (select 1 from content.document_subject s where s.id = document_composition.id));

create policy authored_fragment_revision_scope on content.authored_fragment_revision
  for all
  using (
    exists (select 1 from content.authored_fragment f where f.id = fragment_id)
    and (select rank from registry.classification c where c.id = classification)
        <= core.current_classification_rank()
  )
  with check (
    exists (select 1 from content.authored_fragment f where f.id = fragment_id)
    and (select rank from registry.classification c where c.id = classification)
        <= core.current_classification_rank()
  );

create policy composition_revision_scope on content.composition_revision
  for all
  using (exists (select 1 from content.document_composition c where c.id = composition_id))
  with check (exists (select 1 from content.document_composition c where c.id = composition_id));

create policy typed_binding_scope on content.typed_binding
  for all
  using (exists (select 1 from core.object o where o.id = typed_binding.object_id))
  with check (exists (select 1 from core.object o where o.id = typed_binding.object_id));

create policy composition_input_scope on content.composition_input
  for all
  using (
    exists (select 1 from content.composition_revision r where r.id = composition_revision_id)
    and case input_role
      when 'fragment' then exists (
        select 1 from content.authored_fragment_revision r where r.id = fragment_revision_id)
      when 'composition' then exists (
        select 1 from content.composition_revision r where r.id = child_composition_revision_id)
      when 'resource' then exists (
        select 1
          from content.artifact_version av
          join content.artifact a on a.id = av.artifact_id
          join core.object o on o.id = a.id
         where av.id = resource_version_id)
      when 'binding' then exists (
        select 1 from content.typed_binding b where b.id = binding_id)
      when 'generated_view' then exists (
        select 1 from content.compiled_view v where v.id = compiled_view_id)
      else false
    end
  )
  with check (
    exists (select 1 from content.composition_revision r where r.id = composition_revision_id)
    and case input_role
      when 'fragment' then exists (
        select 1 from content.authored_fragment_revision r where r.id = fragment_revision_id)
      when 'composition' then exists (
        select 1 from content.composition_revision r where r.id = child_composition_revision_id)
      when 'resource' then exists (
        select 1
          from content.artifact_version av
          join content.artifact a on a.id = av.artifact_id
          join core.object o on o.id = a.id
         where av.id = resource_version_id)
      when 'binding' then exists (
        select 1 from content.typed_binding b where b.id = binding_id)
      when 'generated_view' then exists (
        select 1 from content.compiled_view v where v.id = compiled_view_id)
      else false
    end
  );

create policy compilation_basis_read on content.compilation_basis
  for select
  using (
    exists (select 1 from content.composition_revision r where r.id = root_composition_revision_id)
    and (
      (finalized_at is not null
       and (select rank from registry.classification c where c.id = effective_classification)
           <= core.current_classification_rank())
      or
      (finalized_at is null
       and created_by::text = nullif(current_setting('kf.actor', true), ''))
    )
  );

create policy compilation_basis_insert on content.compilation_basis
  for insert
  with check (
    effective_classification is null and finalized_at is null
    and created_by = core.current_actor()
    and exists (select 1 from content.composition_revision r where r.id = root_composition_revision_id)
  );

create policy compilation_basis_finalize on content.compilation_basis
  for update
  using (
    finalized_at is null
    and created_by::text = nullif(current_setting('kf.actor', true), '')
  )
  with check (
    finalized_at is not null
    and effective_classification is not null
    and (select rank from registry.classification c where c.id = effective_classification)
        <= core.current_classification_rank()
  );

create policy compilation_basis_fragment_scope on content.compilation_basis_fragment
  for all
  using (exists (select 1 from content.compilation_basis b where b.id = basis_id))
  with check (exists (select 1 from content.compilation_basis b where b.id = basis_id));

create policy compilation_basis_composition_scope on content.compilation_basis_composition
  for all
  using (exists (select 1 from content.compilation_basis b where b.id = basis_id))
  with check (exists (select 1 from content.compilation_basis b where b.id = basis_id));

create policy compilation_basis_binding_scope on content.compilation_basis_binding
  for all
  using (exists (select 1 from content.compilation_basis b where b.id = basis_id))
  with check (exists (select 1 from content.compilation_basis b where b.id = basis_id));

create policy compilation_run_scope on content.compilation_run
  for all
  using (
    exists (select 1 from content.compilation_basis b where b.id = basis_id)
    and (select rank from registry.classification c where c.id = effective_classification)
        <= core.current_classification_rank()
  )
  with check (
    exists (select 1 from content.compilation_basis b where b.id = basis_id)
    and (select rank from registry.classification c where c.id = effective_classification)
        <= core.current_classification_rank()
  );

create policy compiled_view_scope on content.compiled_view
  for all
  using (
    exists (select 1 from content.compilation_run r where r.id = compilation_run_id)
    and (select rank from registry.classification c where c.id = effective_classification)
        <= core.current_classification_rank()
  )
  with check (
    exists (select 1 from content.compilation_run r where r.id = compilation_run_id)
    and (select rank from registry.classification c where c.id = effective_classification)
        <= core.current_classification_rank()
  );
create policy document_publication_scope on content.document_publication
  for all
  using (
    organization_id = core.current_organization()
    and exists (select 1 from content.document_subject s where s.id = subject_id)
    and (select rank from registry.classification c where c.id = effective_classification)
        <= core.current_classification_rank()
  )
  with check (
    organization_id = core.current_organization()
    and exists (select 1 from content.document_subject s where s.id = subject_id)
    and (select rank from registry.classification c where c.id = effective_classification)
        <= core.current_classification_rank()
  );
create policy document_publication_target_scope on content.document_publication_target
  for all
  using (exists (select 1 from core.object o where o.id = document_publication_target.organization_id))
  with check (exists (select 1 from core.object o where o.id = document_publication_target.organization_id));
create policy document_publication_target_retirement_scope
  on content.document_publication_target_retirement
  for all
  using (
    exists (
      select 1 from content.document_publication_target t
       where t.id = document_publication_target_retirement.target_id
    )
  )
  with check (
    exists (
      select 1 from content.document_publication_target t
       where t.id = document_publication_target_retirement.target_id
    )
  );

create policy proposal_overlay_scope on content.proposal_overlay
  for all
  using (exists (select 1 from content.document_subject s where s.id = subject_id))
  with check (exists (select 1 from content.document_subject s where s.id = subject_id));

-- Preservation is cross-organization and cross-classification by design. kf_backup has no
-- application access context, so subject-derived policies would otherwise turn a successful
-- pg_dump into an empty archive. This role remains SELECT-only.
do $$
declare v_table text;
begin
  foreach v_table in array array[
    'document_subject', 'document_source_holder', 'authored_fragment',
    'document_composition', 'authored_fragment_revision', 'composition_revision',
    'typed_binding', 'composition_input', 'compilation_basis',
    'compilation_basis_fragment', 'compilation_basis_composition',
    'compilation_basis_binding', 'compilation_run', 'compiled_view', 'proposal_overlay',
    'document_publication_target', 'document_publication_target_retirement',
    'document_publication'
  ] loop
    execute format(
      'create policy %I on content.%I for select to kf_backup using (true)',
      v_table || '_backup', v_table
    );
  end loop;
end
$$;

grant select on content.document_subject, content.document_source_holder,
                content.authored_fragment, content.authored_fragment_revision,
                content.document_composition, content.composition_revision,
                content.composition_input, content.typed_binding,
                content.compilation_basis, content.compilation_basis_fragment,
                content.compilation_basis_composition, content.compilation_basis_binding,
                content.compilation_run, content.compiled_view, content.proposal_overlay,
                content.document_publication_target,
                content.document_publication_target_retirement,
                content.document_publication
  to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;

grant insert on content.document_subject, content.document_source_holder,
                content.authored_fragment, content.authored_fragment_revision,
                content.document_composition, content.composition_revision,
                content.composition_input, content.typed_binding,
                content.compilation_basis, content.compilation_basis_fragment,
                content.compilation_basis_composition, content.compilation_basis_binding,
                content.proposal_overlay, content.document_publication
  to kf_app;
grant update (current_holder_id) on content.document_subject to kf_app;
grant insert on content.compilation_run, content.compiled_view to kf_worker;
grant usage, select on all sequences in schema content to kf_app, kf_worker;
revoke all on function content.finalize_compilation_basis(uuid) from public;
grant execute on function content.finalize_compilation_basis(uuid) to kf_app;
revoke all on function content.document_basis_classifier_active() from public;
grant execute on function content.document_basis_classifier_active()
  to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;

revoke update, delete, truncate on content.document_source_holder,
                                      content.authored_fragment,
                                      content.authored_fragment_revision,
                                      content.document_composition,
                                      content.composition_revision,
                                      content.composition_input,
                                      content.typed_binding,
                                      content.compilation_basis,
                                      content.compilation_basis_fragment,
                                      content.compilation_basis_composition,
                                      content.compilation_basis_binding,
                                      content.compilation_run,
                                      content.compiled_view,
                                      content.proposal_overlay,
                                      content.document_publication_target,
                                      content.document_publication_target_retirement,
                                      content.document_publication
  from kf_app, kf_worker;
revoke insert on content.document_publication_target,
                 content.document_publication_target_retirement
  from kf_app, kf_worker;

comment on table content.document_source_holder is
  'Immutable linear Holder history. document_subject.current_holder_id names the sole writer.';
comment on table content.compilation_basis is
  'Complete immutable compiler input identity, canonically digested by @kf/documents.';
comment on table content.proposal_overlay is
  'Derived revision-preconditioned operations; never authored source or approval authority.';

-- migrate:down

drop policy if exists object_document_basis_classifier on core.object;
drop trigger if exists core_object_compiled_artifact_classification on core.object;
drop function if exists content.refuse_compiled_artifact_classification_downgrade();

drop trigger if exists document_publication_authority on content.document_publication;
drop function if exists content.enforce_document_publication();
drop trigger if exists document_publication_target_retirement_lock
  on content.document_publication_target_retirement;
drop function if exists content.lock_document_publication_target_retirement();
drop function if exists content.lock_document_publication_target(uuid);
drop trigger if exists document_subject_holder_revision_complete on content.document_subject;
drop trigger if exists document_subject_holder_switch on content.document_subject;
drop function if exists content.enforce_holder_switch_has_revision();
drop function if exists content.enforce_document_holder_switch();
drop function if exists content.finalize_compilation_basis(uuid);

drop table if exists content.document_publication;
drop table if exists content.document_publication_target_retirement;
drop table if exists content.document_publication_target;
alter table if exists quality.controlled_document
  drop constraint if exists controlled_document_content_version_identity;
drop table if exists content.proposal_overlay;
drop table if exists content.composition_input;
drop table if exists content.compilation_basis_binding;
drop table if exists content.compilation_basis_composition;
drop table if exists content.compilation_basis_fragment;
drop table if exists content.compiled_view;
drop table if exists content.compilation_run;
drop table if exists content.compilation_basis;
drop table if exists content.typed_binding;
drop table if exists content.authored_fragment_revision;
drop table if exists content.composition_revision;
drop table if exists content.authored_fragment;
drop table if exists content.document_composition;
alter table if exists content.document_subject
  drop constraint if exists document_subject_current_holder;
drop table if exists content.document_source_holder;
drop table if exists content.document_subject;
drop function if exists content.document_basis_classifier_active();
drop table if exists content.document_basis_classifier_lease;

drop index if exists content.document_compiled_artifact_digest;
drop index if exists core.document_binding_snapshot_identity;
drop function if exists content.refuse_partial_compiled_view();
drop function if exists content.enforce_compilation_run_request();
drop function if exists content.enforce_compilation_run_qualification();
drop function if exists content.enforce_compilation_basis_finalization();
drop function if exists content.refuse_finalized_basis_member();
drop function if exists content.refuse_finalized_composition_input();
drop function if exists content.enforce_contiguous_composition_order();
drop function if exists content.refuse_composition_cycle();
drop function if exists content.enforce_fragment_revision_is_current_holder();
drop function if exists content.enforce_fragment_revision_holder_scope();
