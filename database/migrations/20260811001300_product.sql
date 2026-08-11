-- migrate:up

-- The product schema: configuration items, interface contracts, physical bindings,
-- baselines and releases.
--
-- The distinction this schema exists to hold is between what was DESIGNED, what was
-- BUILT, and what a customer actually HAS. A configuration item is a design; a physical
-- binding is a serial number in someone's hands. Collapsing them is how a recall ends up
-- unable to answer "which units are affected".

create table product.configuration_item (
  id             uuid primary key references core.object (id) on delete restrict,
  item_kind      text not null check (item_kind in (
    'hardware', 'software', 'firmware', 'mechanical', 'document', 'tooling', 'data'
  )),
  part_number    text not null check (length(btrim(part_number)) between 1 and 64),
  revision_label text not null check (length(btrim(revision_label)) between 1 and 32),
  parent_system  uuid not null references core.object (id) on delete restrict,

  -- One revision of one part, once. Two rows claiming to be the same revision is how two
  -- different designs end up shipping under one name.
  unique (part_number, revision_label)
);

create index configuration_item_by_system on product.configuration_item (parent_system);

create table product.interface_contract (
  id             uuid primary key references core.object (id) on delete restrict,
  interface_kind text not null check (interface_kind in (
    'electrical', 'mechanical', 'thermal', 'data', 'protocol', 'service', 'regulatory'
  )),
  -- GENERATION, not revision. R4 scopes conformance to a generation deliberately: a
  -- revision changes without renegotiating the interface, so conformance that named one
  -- would expire on every rework and mean nothing after the second.
  generation     text not null check (generation ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$'),
  provider       uuid not null references core.object (id) on delete restrict,
  consumer       uuid references core.object (id) on delete restrict,
  specification  text not null check (length(btrim(specification)) between 1 and 8000),

  unique (provider, interface_kind, generation),
  -- An interface a thing has with itself is a note, not a contract.
  constraint interface_two_parties check (consumer is null or consumer <> provider)
);

create index interface_by_provider on product.interface_contract (provider);
create index interface_by_consumer on product.interface_contract (consumer) where consumer is not null;

-- What conforms to what, at which generation. Kept as a typed row rather than a relation
-- because the GENERATION is part of the claim: "this item conforms" is not a fact until it
-- says which generation it was tested against.
create table product.interface_conformance (
  id                  uuid primary key default uuidv7(),
  configuration_item  uuid not null references product.configuration_item (id) on delete restrict,
  interface_contract  uuid not null references product.interface_contract (id) on delete restrict,
  generation          text not null,
  -- The evidence. A conformance claim with no verification behind it is an assertion.
  verified_by         uuid references core.object (id) on delete restrict,
  recorded_at         timestamptz not null default now(),
  recorded_by         uuid not null,

  unique (configuration_item, interface_contract, generation)
);

create table product.physical_binding (
  id                 uuid primary key references core.object (id) on delete restrict,
  configuration_item uuid not null references product.configuration_item (id) on delete restrict,
  serial_number      text not null check (length(btrim(serial_number)) between 1 and 64),
  installed_on       timestamptz,
  removed_on         timestamptz,
  location           text,

  -- A serial number identifies ONE physical thing. Two rows for one serial is either a
  -- duplicate record or two objects sharing an identity, and both are worth refusing.
  unique (serial_number),
  constraint binding_removed_after_install
    check (removed_on is null or installed_on is null or removed_on >= installed_on)
);

create index binding_by_item on product.physical_binding (configuration_item);

-- Baselines and releases: a frozen set of items, and what shipped.
create table product.baseline_item (
  baseline_id        uuid not null references core.object (id) on delete restrict,
  configuration_item uuid not null references product.configuration_item (id) on delete restrict,
  primary key (baseline_id, configuration_item)
);

create table product.release_item (
  release_id         uuid not null references core.object (id) on delete restrict,
  configuration_item uuid not null references product.configuration_item (id) on delete restrict,
  primary key (release_id, configuration_item)
);

-- Which units a baseline or change applies to. `effectivity` is the word the industry uses
-- for the answer to "from which serial number does this take effect".
create table product.effectivity (
  id            uuid primary key default uuidv7(),
  subject_id    uuid not null references core.object (id) on delete restrict,
  applies_from  text,
  applies_to    text,
  note          text,
  -- An effectivity that names neither end applies to everything, which is a claim someone
  -- should have to make explicitly rather than by leaving two fields blank.
  constraint effectivity_bounded check (applies_from is not null or applies_to is not null)
);

grant select on all tables in schema product
  to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on product.configuration_item, product.interface_contract,
                product.interface_conformance, product.physical_binding,
                product.baseline_item, product.release_item, product.effectivity
  to kf_app;
-- Installation and removal are field facts recorded as they happen; everything else about a
-- binding is fixed at creation.
grant update (installed_on, removed_on, location) on product.physical_binding to kf_app;
grant usage, select on all sequences in schema product to kf_app, kf_worker;

-- migrate:down

drop table product.effectivity;
drop table product.release_item;
drop table product.baseline_item;
drop table product.physical_binding;
drop table product.interface_conformance;
drop table product.interface_contract;
drop table product.configuration_item;
