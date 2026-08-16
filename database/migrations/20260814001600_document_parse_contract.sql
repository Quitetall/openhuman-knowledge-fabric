-- migrate:up

-- Parsing is a deterministic projection, not an assertion that Pandoc's richer AST fits the
-- atom vocabulary losslessly. Bind every parse to an explicit projection contract and retain
-- exact, digest-addressed conversion-loss records.
alter table content.document_parse
  add column projection_contract text not null default 'kf.pandoc-atoms.v1',
  add column conversion_loss jsonb not null default '[{
    "code": "legacy_parse_loss_unmeasured",
    "path": "/",
    "message": "Parse predates explicit conversion-loss measurement",
    "sourceDigest": "0000000000000000000000000000000000000000000000000000000000000000"
  }]'::jsonb;

alter table content.document_parse
  alter column projection_contract drop default,
  alter column conversion_loss drop default,
  add constraint document_parse_projection_contract_nonempty
    check (length(btrim(projection_contract)) > 0),
  add constraint document_parse_conversion_loss_array
    check (jsonb_typeof(conversion_loss) = 'array');

comment on column content.document_parse.projection_contract is
  'Versioned KF projection algorithm; parser_version alone identifies only upstream Pandoc.';
comment on column content.document_parse.conversion_loss is
  'Stable-path, source-digest-addressed Pandoc claims not represented losslessly by atoms.';

-- migrate:down

alter table content.document_parse
  drop constraint document_parse_conversion_loss_array,
  drop constraint document_parse_projection_contract_nonempty,
  drop column conversion_loss,
  drop column projection_contract;
