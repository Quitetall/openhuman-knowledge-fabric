-- migrate:up

-- Extend the existing append-only copy record. A cloud PUT is not a physical-domain
-- approval, and a digest without a provider version cannot select the copy to restore.
alter table ops.backup_copy
  add column provider_object jsonb,
  drop constraint backup_copy_offsite_basis_check,
  drop constraint backup_copy_offsite_matches_basis,
  add constraint backup_copy_offsite_basis_check
    check (offsite_basis in ('remote-host', 'remote-object', 'attested-domain', 'same-host', 'local-unattested')),
  add constraint backup_copy_offsite_matches_basis
    check (offsite_basis is null or offsite = (offsite_basis in ('remote-host', 'remote-object', 'attested-domain'))),
  add constraint backup_copy_remote_object_has_identity
    check (offsite_basis is distinct from 'remote-object' or provider_object is not null),
  add constraint backup_copy_provider_identity_is_closed
    check (provider_object is null or (
      offsite and offsite_basis in ('remote-object', 'attested-domain')
      and jsonb_typeof(provider_object) = 'object'
      and provider_object ?& array['format','endpoint','bucket','key','versionId','sha256','sizeBytes']
      and provider_object - array['format','endpoint','bucket','key','versionId','sha256','sizeBytes'] = '{}'::jsonb
      and provider_object->>'format' = 'kf-offsite-object-v1'
      and jsonb_typeof(provider_object->'format') = 'string'
      and jsonb_typeof(provider_object->'endpoint') = 'string'
      and provider_object->>'endpoint' ~ '^https://s3[.][a-z]{2}-[a-z]+-[0-9]{3}[.]backblazeb2[.]com$'
      and jsonb_typeof(provider_object->'bucket') = 'string'
      and provider_object->>'bucket' ~ '^[a-z0-9][a-z0-9-]{4,61}[a-z0-9]$'
      and jsonb_typeof(provider_object->'sha256') = 'string'
      and provider_object->>'sha256' = ciphertext_sha256
      and jsonb_typeof(provider_object->'key') = 'string'
      and provider_object->>'key' = 'kf-backups/v1/' || ciphertext_sha256 || '.tar.gpg'
      and jsonb_typeof(provider_object->'versionId') = 'string'
      and provider_object->>'versionId' ~ '^[!-~]+$'
      and length(provider_object->>'versionId') between 1 and 1024
      and provider_object->>'versionId' <> 'null'
      and jsonb_typeof(provider_object->'sizeBytes') = 'number'
      and provider_object->>'sizeBytes' ~ '^[1-9][0-9]{0,9}$'
      and (provider_object->>'sizeBytes')::numeric <= 5368709120
    ) is true);

comment on column ops.backup_copy.provider_object is
  'Closed kf-offsite-object-v1 identity observed after exact-version read-back: '
  'endpoint, non-revealing bucket, opaque ciphertext-hash key, version, size and SHA-256. '
  'No credential, document name, retention promise or physical-domain approval. Null for rsync copies.';
comment on column ops.backup_copy.offsite_basis is
  'Observed remote host or remote cloud object, human-attested physical domain, '
  'explicit same-host or unattested local path. Cloud identity is not physical-domain approval.';

-- migrate:down
-- kf:forward-only removing provider version identities would destroy restore-critical lineage for cloud copies recorded under this schema
