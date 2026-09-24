-- migrate:up

-- Every digest in a document parse receipt carries a format tag inside its preimage, and every
-- parse records which receipt format it was written under.
--
-- KF-SAS-RQ-016 requires every digest to be taken over an RFC 8785 canonical form under a named
-- format tag that is part of the preimage. A parse receipt carries four digests, and none had a
-- tag: an atom's digest(claim), a conversion loss's digest(source), the parse's
-- digest(conversionLoss), and its content digest over { projectionContract, atoms,
-- conversionLoss } — `projectionContract` is the parser's own vocabulary, chosen by whichever
-- parser ran, not a format of the digest. The receipts already recorded cannot be re-hashed:
-- each keeps its exact preimages beside its digests precisely so they can be verified as they
-- are. So the change is a new format beside the old one, recorded per parse:
--
--   kf-document-parse-v1  the four untagged digests                                (as recorded)
--   kf-document-parse-v2  atom         { …claim, format: 'kf-document-atom-v1' }
--                         loss source  { source, format: 'kf-document-loss-source-v1' }
--                         loss         { conversionLoss, format: 'kf-document-conversion-loss-v1' }
--                         content      { projectionContract, atoms: [atom preimages],
--                                        conversionLoss, format: 'kf-document-projection-v1' }
--
-- Rows already here are v1 — the ADD COLUMN default fills them — and the default then becomes v2,
-- so the writer never names a format: the database sets it, and refuses a new row under any
-- other. The insert triggers check the preimage shapes of v2, which is every row they can see:
-- an export restore runs with user triggers off and carries each row's recorded format (an
-- archive from before this column restores its parses as v1, see the importer). The loss-source
-- digests inside `conversion_loss` are not recomputed here, as they were not before; the
-- application recomputes all four when a parser hands it a receipt.

alter table content.document_parse
  add column digest_format text not null default 'kf-document-parse-v1'
    constraint document_parse_digest_format_known
      check (digest_format in ('kf-document-parse-v1', 'kf-document-parse-v2'));

alter table content.document_parse alter column digest_format set default 'kf-document-parse-v2';

comment on column content.document_parse.digest_format is
  'The receipt format this parse''s digests were computed under. kf-document-parse-v1: the '
  'untagged atom, loss-source, loss and content digests every parse before 20260925114000 used. '
  'kf-document-parse-v2: each digest carries its own format tag in its preimage. Set by the '
  'database (the default); a new row naming anything else is refused.';

create or replace function content.verify_document_parse_preimage() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content
as $$
declare
  v_loss jsonb;
  v_projection jsonb;
  v_artifact_digest text;
begin
  if new.digest_format is distinct from 'kf-document-parse-v2' then
    raise exception 'document parse digest format % is not kf-document-parse-v2', new.digest_format
      using errcode = 'integrity_constraint_violation',
            hint = 'Every parse recorded since 20260925114000 is kf-document-parse-v2; leave '
                   'digest_format to its default.';
  end if;
  if new.source_digest is null
     or new.loss_digest is null
     or new.loss_preimage is null
     or new.projection_preimage is null then
    raise exception 'new document parses require complete source, loss, and projection preimages'
      using errcode = 'not_null_violation';
  end if;
  if octet_length(new.loss_preimage) > 67108864
     or octet_length(new.projection_preimage) > 67108864 then
    raise exception 'document parse preimage exceeds 64 MiB safety limit'
      using errcode = 'program_limit_exceeded';
  end if;
  select sha256 into v_artifact_digest
    from content.artifact_version where id = new.artifact_version_id;
  if not found or v_artifact_digest is distinct from new.source_digest then
    raise exception 'document parse source digest differs from exact artifact version'
      using errcode = 'integrity_constraint_violation';
  end if;
  begin
    v_loss := new.loss_preimage::jsonb;
    v_projection := new.projection_preimage::jsonb;
  exception when others then
    raise exception 'document parse preimage is not valid JSON'
      using errcode = 'invalid_parameter_value';
  end;
  if encode(public.digest(convert_to(new.loss_preimage, 'UTF8'), 'sha256'), 'hex')
       is distinct from new.loss_digest
     or not content.provenance_exact_keys(v_loss, array['format', 'conversionLoss'])
     or v_loss ->> 'format' is distinct from 'kf-document-conversion-loss-v1'
     or v_loss -> 'conversionLoss' is distinct from new.conversion_loss then
    raise exception 'document parse loss digest or preimage differs from conversion-loss rows'
      using errcode = 'integrity_constraint_violation';
  end if;
  if encode(public.digest(convert_to(new.projection_preimage, 'UTF8'), 'sha256'), 'hex')
       is distinct from new.content_digest
     or not content.provenance_exact_keys(
       v_projection, array['format', 'projectionContract', 'atoms', 'conversionLoss']
     )
     or v_projection ->> 'format' is distinct from 'kf-document-projection-v1'
     or v_projection ->> 'projectionContract' is distinct from new.projection_contract
     or jsonb_typeof(v_projection -> 'atoms') <> 'array'
     or v_projection -> 'conversionLoss' is distinct from new.conversion_loss then
    raise exception 'document projection digest or preimage differs from parse receipt'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
end;
$$;

create or replace function content.verify_document_atom_preimage() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, content
as $$
declare
  v_claim jsonb;
  v_format text;
begin
  -- An atom is written with its parse, so its parse is v2; an atom added to a parse recorded
  -- under v1 is not a restore (restores run with triggers off) and is refused.
  select digest_format into v_format from content.document_parse where id = new.parse_id;
  if v_format is distinct from 'kf-document-parse-v2' then
    raise exception 'document atom belongs to a parse recorded under %, not kf-document-parse-v2',
      coalesce(v_format, 'no parse')
      using errcode = 'integrity_constraint_violation';
  end if;
  if new.atom_preimage is null then
    raise exception 'new document atoms require an exact canonical claim preimage'
      using errcode = 'not_null_violation';
  end if;
  begin
    v_claim := new.atom_preimage::jsonb;
  exception when others then
    raise exception 'document atom preimage is not valid JSON'
      using errcode = 'invalid_parameter_value';
  end;
  if encode(public.digest(convert_to(new.atom_preimage, 'UTF8'), 'sha256'), 'hex')
       is distinct from new.atom_digest
     or not content.provenance_exact_keys(
       v_claim, array['format', 'ordinal', 'kind', 'level', 'text', 'attributes']
     )
     or v_claim ->> 'format' is distinct from 'kf-document-atom-v1'
     or (v_claim ->> 'ordinal')::integer is distinct from new.ordinal
     or v_claim ->> 'kind' is distinct from new.atom_kind
     or (case when jsonb_typeof(v_claim -> 'level') = 'null'
           then new.heading_level is not null
           else (v_claim ->> 'level')::integer is distinct from new.heading_level
         end)
     or v_claim ->> 'text' is distinct from new.text_content
     or v_claim -> 'attributes' is distinct from new.attributes then
    raise exception 'document atom digest or preimage differs from atom fields'
      using errcode = 'integrity_constraint_violation';
  end if;
  return new;
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'document atom preimage contains malformed numeric fields'
      using errcode = 'invalid_parameter_value';
end;
$$;

-- migrate:down
-- kf:forward-only parses recorded after this migration carry kf-document-parse-v2 preimages; restoring the untagged triggers would refuse every such receipt's shape and dropping the column would erase which format each recorded parse is verifiable under
