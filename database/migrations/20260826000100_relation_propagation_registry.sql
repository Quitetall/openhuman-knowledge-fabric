-- migrate:up

-- OW-WAR-0054 M2B: relevance policy is registry data, not compiler code.
alter table registry.relation_type
  add column person_anchor boolean not null default false,
  add column propagation_class text check (propagation_class in (
    'composition_down', 'version_both', 'provenance_backward',
    'lateral_none', 'authority_one_hop_up'
  )),
  add column anchor_depth integer not null default 0 check (anchor_depth >= 0);

comment on column registry.relation_type.person_anchor is
  'Whether this relation may seed relevance from a person anchor.';
comment on column registry.relation_type.propagation_class is
  'Machine-readable relevance propagation policy consumed by the master-record compiler.';
comment on column registry.relation_type.anchor_depth is
  'Finite traversal depth for an anchored relevance closure.';

-- migrate:down
-- kf:forward-only dropping propagation metadata would return relevance policy to compiler-owned lists
