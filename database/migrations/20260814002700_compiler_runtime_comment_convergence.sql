-- migrate:up

-- Early dogfood applied migration 005 before its preserved-registration qualification was
-- explained in schema metadata. Converge already-applied databases to fresh-install DDL.
comment on column content.document_compiler_registration.runtime_closure_digest is
  'RFC 8785 digest of ordered sandbox path and exact runtime-file content-digest records; NULL marks a preserved pre-v005 registration that is disabled until explicit owner migration.';

-- migrate:down

-- Migration 005 already declares this wording on a fresh chain. Keep its deterministic
-- metadata instead of reintroducing environment-specific early-dogfood drift.
comment on column content.document_compiler_registration.runtime_closure_digest is
  'RFC 8785 digest of ordered sandbox path and exact runtime-file content-digest records; NULL marks a preserved pre-v005 registration that is disabled until explicit owner migration.';
