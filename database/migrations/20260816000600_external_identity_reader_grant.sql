-- migrate:up

-- `org.external_identity` maps an OIDC issuer+subject to a person: who can sign in as whom.
--
-- Stage one of the typed-table row-level security work
-- (`20260816000300_typed_table_row_security.sql`) deliberately left this table alone, and
-- explained why. It is read by `resolveIn` BEFORE the caller's organization claim has been
-- verified — `resolveCaller` binds the access context FROM the claim and then proves it. A
-- policy keyed on that context therefore answers an authentication question with a scope
-- answer: when it was tried, a valid token naming the wrong organization stopped reporting
-- `role_not_held` and started reporting `unknown_subject`, and a person whose own record sits
-- above the classification ceiling they requested could not sign in at all.
--
-- The exposure that left is narrow and real: kf_readonly and kf_auditor hold `select` on the
-- table and connect directly, so the whole issuer-to-person mapping was readable by both,
-- across every organization. That is not record substance, but it is the shape of an
-- identity graph — which external accounts belong to which people — and it is exactly the
-- kind of thing that is boring until it is not.
--
-- The fix is the grant rather than a policy. Those two roles have no need to read this table
-- directly: everything they can legitimately learn from it, they can reach through the API,
-- where a verified identity exists and the answer is scoped by something better than a claim.
-- Withdrawing the grant closes the exposure and does not touch the authentication path at
-- all, because the authentication path runs as kf_app.
--
-- Who keeps it, and why each one needs it:
--
--   kf_app       resolves the caller at sign-in, links and revokes identities.
--   kf_worker    the same code path runs in the worker.
--   kf_backup    preservation exports the table (`external-identities` in
--                PRESERVATION_IMPORT_TARGETS); a backup missing the identity links restores a
--                fabric nobody can sign in to.
--
-- kf_checkpoint never had it and does not need it.

revoke select on org.external_identity from kf_readonly, kf_auditor;

comment on table org.external_identity is
  'Issuer+subject to person mapping. Read before the caller''s organization claim is verified, '
  'so it is protected by grant rather than by a policy keyed on that claim: kf_app and '
  'kf_worker resolve identities, kf_backup preserves them, and nothing else reads it directly.';

-- migrate:down

-- Forward-only. Reverting would return the whole issuer-to-person mapping, across every
-- organization, to two roles that reach the same information through the API with a verified
-- identity attached.
