-- migrate:up

-- Key withdrawal and tombstone admission are one key-scoped serialization domain. A
-- tombstone that waits behind a revocation must observe that committed revocation before it
-- can admit a signature; a revocation that waits behind a tombstone is ordered after it.
create or replace function secure_object.enforce_key_revocation_action() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, secure_object
as $$
declare
  v_key secure_object.authority_signing_key%rowtype;
  v_action uuid;
begin
  perform pg_advisory_xact_lock(
    hashtextextended(
      'kf:secure-object:authority-signing-key:' || new.signing_key_registry_id::text,
      0
    )
  );

  select key.* into v_key
    from secure_object.authority_signing_key key
   where key.id = new.signing_key_registry_id;
  if not found then
    raise exception 'SOA signing key is not registered'
      using errcode = 'foreign_key_violation';
  end if;

  select secure_object.require_exact_action(
    'revoke_secure_object_authority_key',
    v_key.organization_id,
    jsonb_build_object(
      'signingKeyRegistryId', new.signing_key_registry_id,
      'reasonCode', new.reason_code
    )
  ) into v_action;
  new.actor_id := core.current_actor();
  new.action_id := v_action;
  new.revoked_at := secure_object.action_effective_at(v_action);
  return new;
end
$$;

create or replace function secure_object.enforce_erasure_tombstone_action() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, core, secure_object, ml
as $$
declare
  v_request secure_object.erasure_request%rowtype;
  v_key secure_object.authority_signing_key%rowtype;
  v_action uuid;
  v_action_effective_at timestamptz;
  v_erased_at timestamptz;
  v_erased_at_text text;
  v_signer_id uuid;
  v_public_key_spki_der bytea;
  v_signature bytea;
  v_unsigned_tombstone text;
begin
  select request.* into v_request
    from secure_object.erasure_request request
   where request.id = new.erasure_request_id;
  if not found then
    raise exception 'secure-object erasure request does not exist'
      using errcode = 'foreign_key_violation';
  end if;

  -- Read the immutable registry row once to validate exact action semantics before taking the
  -- transaction lock. The row and revocation state are read again after any lock wait.
  select key.* into v_key
    from secure_object.authority_signing_key key
   where key.id = new.signing_key_registry_id;
  if not found then
    raise exception 'SOA signing key is not registered'
      using errcode = 'foreign_key_violation';
  end if;

  select secure_object.require_exact_action(
    'record_secure_object_erasure',
    v_request.organization_id,
    jsonb_build_object(
      'requestId', v_request.id,
      'authorityRef', v_request.external_authority_ref,
      'revisionRef', v_request.external_revision_ref,
      'externalContentSha256', v_request.external_content_sha256,
      'purpose', v_request.purpose,
      'workloadIdentityRef', v_request.workload_identity_ref,
      'policyDecisionRef', v_request.policy_decision_ref,
      'signingKeyRegistryId', v_key.id
    )
  ) into v_action;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'kf:secure-object:authority-signing-key:' || new.signing_key_registry_id::text,
      0
    )
  );

  -- PostgreSQL cannot refresh a transaction-wide REPEATABLE READ/SERIALIZABLE snapshot after
  -- this wait. Refuse those modes at the exact append authority instead of admitting a
  -- signature against revocation state that may now be stale.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception
      'secure-object erasure tombstone admission requires READ COMMITTED transaction isolation'
      using errcode = 'invalid_transaction_state';
  end if;

  -- READ COMMITTED gives this statement a new snapshot after the advisory-lock wait. Keep the
  -- revocation predicate here rather than in the pre-lock registry lookup: otherwise a
  -- concurrent uncommitted revocation can be missed for the life of this INSERT statement.
  select key.* into v_key
    from secure_object.authority_signing_key key
   where key.id = new.signing_key_registry_id
     and not exists (
       select 1
         from secure_object.authority_signing_key_revocation revoked
        where revoked.signing_key_registry_id = key.id
     );
  if not found then
    raise exception 'SOA signing key is not registered and active for exact authority'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  select action.actor_id, action.effective_at
    into v_signer_id, v_action_effective_at
    from core.action action
   where action.id = v_action;
  if v_key.organization_id is distinct from v_request.organization_id
     or v_key.external_authority_ref is distinct from v_request.external_authority_ref
     or v_key.valid_from > v_action_effective_at
     or (v_key.valid_until is not null and v_key.valid_until <= v_action_effective_at) then
    raise exception 'SOA signing key is not registered and active for exact authority'
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Node's Date and tombstoneBytes use exactly millisecond UTC ISO-8601. Store and sign the
  -- same canonical timestamp even if a direct SQL action supplied finer PostgreSQL precision.
  v_erased_at := date_trunc('milliseconds', v_action_effective_at);
  v_erased_at_text := secure_object.iso8601(v_erased_at);

  -- All values are authoritative rows, not caller-provided receipt columns. Keys are emitted
  -- in RFC 8785 lexicographic order, matching packages/integration tombstoneBytes exactly.
  v_unsigned_tombstone := '{'
    || '"erased_at":' || to_jsonb(v_erased_at_text)::text
    || ',"erasure_request_id":' || to_jsonb(v_request.id::text)::text
    || ',"external_content_sha256":' || to_jsonb(v_request.external_content_sha256)::text
    || ',"policy_decision_ref":' || to_jsonb(v_request.policy_decision_ref)::text
    || ',"purpose":' || to_jsonb(v_request.purpose::text)::text
    || ',"signer_action_id":' || to_jsonb(v_action::text)::text
    || ',"signer_id":' || to_jsonb(v_signer_id::text)::text
    || ',"signing_key_id":' || to_jsonb(v_key.key_id)::text
    || ',"signing_key_registry_id":' || to_jsonb(v_key.id::text)::text
    || ',"version":"kf-secure-object-erasure-tombstone/v1"'
    || ',"workload_identity_ref":' || to_jsonb(v_request.workload_identity_ref)::text
    || '}';

  if new.signature is null or new.signature !~ '^[A-Za-z0-9+/]{86}==$' then
    raise exception 'erasure tombstone signature must be canonical base64 for 64 bytes'
      using errcode = 'invalid_parameter_value';
  end if;
  begin
    v_signature := decode(new.signature, 'base64');
  exception
    when others then
      raise exception 'erasure tombstone signature must be canonical base64 for 64 bytes'
        using errcode = 'invalid_parameter_value';
  end;
  if octet_length(v_signature) <> 64
     or replace(encode(v_signature, 'base64'), E'\n', '') <> new.signature then
    raise exception 'erasure tombstone signature must be canonical base64 for 64 bytes'
      using errcode = 'invalid_parameter_value';
  end if;

  v_public_key_spki_der := decode(v_key.public_key_spki_der_base64, 'base64');
  if octet_length(v_public_key_spki_der) <> 44
     or encode(substring(v_public_key_spki_der from 1 for 12), 'hex')
       <> '302a300506032b6570032100'
     or not ml.verify_ed25519(
       substring(v_public_key_spki_der from 13 for 32),
       convert_to(v_unsigned_tombstone, 'UTF8'),
       v_signature
     ) then
    raise exception 'erasure tombstone Ed25519 signature verification failed'
      using errcode = 'integrity_constraint_violation';
  end if;

  new.actor_id := v_signer_id;
  new.action_id := v_action;
  new.erased_at := v_erased_at;
  new.signing_key_id := v_key.key_id;
  return new;
end
$$;

revoke execute on function secure_object.enforce_key_revocation_action() from public;
revoke execute on function secure_object.enforce_erasure_tombstone_action() from public;

-- migrate:down

-- Forward-only security hardening: restoring the prior trigger bodies would reintroduce
-- arbitrary-signature admission and the revocation race.
