-- migrate:up

-- Federated identity: which external subject is which person.
--
-- The identity provider answers ONE question — who is this — and nothing else. It does not
-- say what they may do here.
--
-- That split is the whole design. An access token can carry role claims, and every OIDC
-- tutorial encourages it, but a role claim means the IdP decides authority in the Fabric. Then
-- an admin in Keycloak can grant themselves technical authority over a device design without
-- touching this system, and the record of who could approve what lives somewhere with no audit
-- chain and no separation of duty. Roles stay in `org.role_assignment`, checked live, on every
-- action.
--
-- So a token establishes a SUBJECT; this table maps that subject to a person; and the person's
-- authority is whatever the database says it is at the moment they act.

create table org.external_identity (
  id            uuid primary key default uuidv7(),
  -- The issuer, exactly as it appears in the token's `iss`. Part of the key because subject
  -- identifiers are only unique WITHIN an issuer: `sub` 1234 at one provider and `sub` 1234
  -- at another are different people, and a table keyed on subject alone would merge them.
  issuer        text not null check (length(btrim(issuer)) between 1 and 512),
  subject       text not null check (length(btrim(subject)) between 1 and 255),
  person_id     uuid not null references org.person (id) on delete restrict,

  -- What the provider called them when they were linked. For a human reading an access
  -- review, not for matching — the display name changes and the subject does not.
  provider_label text,

  linked_at     timestamptz not null default now(),
  linked_by     uuid not null references core.object (id),
  -- Set when the link is withdrawn. Rows are never deleted: "this person used to be able to
  -- sign in as that subject" is a fact an investigation needs.
  revoked_at    timestamptz,

  constraint external_identity_unique unique (issuer, subject)
);

create index external_identity_by_person on org.external_identity (person_id);

-- One live link per subject, enforced rather than intended. Two people sharing a subject would
-- make every action ambiguous about who performed it.
create unique index external_identity_one_live
  on org.external_identity (issuer, subject)
  where revoked_at is null;

comment on table org.external_identity is
  'Maps an identity provider subject to a person. The provider answers who; this database '
  'answers what they may do. Role claims in a token are deliberately never consulted.';

grant select on org.external_identity to kf_app, kf_worker, kf_readonly, kf_auditor, kf_backup;
grant insert on org.external_identity to kf_app;
-- Revocation is the only mutation. A link cannot be repointed at a different person: that
-- would silently reattribute every action the subject took before the change.
grant update (revoked_at) on org.external_identity to kf_app;

-- migrate:down

drop table org.external_identity;
