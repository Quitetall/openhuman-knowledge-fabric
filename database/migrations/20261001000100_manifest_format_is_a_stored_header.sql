-- migrate:up

-- Reading a JSON field detoasts the entire manifest, even when only its format is needed.
-- This header is derived from the immutable portable claim, not separately authored authority.
-- Canonical exports retain their existing shape; PostgreSQL recomputes it on archive import.
alter table content.master_record
  add column manifest_format text generated always as (manifest ->> 'format') stored;

comment on column content.master_record.manifest_format is
  'Derived format header: exact manifest format without detoasting its membership/payload JSON. '
  'Not an independent authority field; canonical export continues to preserve the manifest.';

-- migrate:down
alter table content.master_record drop column manifest_format;
