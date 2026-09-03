# Google Drive is an external Source Holder: ingestion copies, cites the revision, and names the exporter

**Status:** accepted — implemented 2026-09-02; decides the deferred design in ADR 0009 in its
narrowest form
**Date raised:** 2026-09-01
**Date decided:** 2026-09-01
**Date implemented:** 2026-09-02
**Decision owner:** technical authority
**Scope:** how a document that lives in Google Drive enters the Fabric, what is recorded about
where it came from, and what is deliberately not built

## The problem

ADR 0009 deferred Drive ingestion and left three questions open: what replaces a git commit
sha for a non-git source, whether a Drive document may become a controlled document at all,
and whether the seam should be generic. Two of those were bigger than the need. The need is
that a person can point `kf ingest` at a Drive file and get an artifact version whose origin
is recorded well enough that a later reader can tell what was read, at which revision, and how
it was converted.

## Decision

**Drive is an external Source Holder, and ingestion is a copy.** A Drive file enters by the
SAME path a local file does — the bytes are fetched, hashed, written to the working store with
create-only semantics, and attached by `attach_evidence` — so nothing downstream (parsing,
atoms, master records, projections, publication) learns that Drive exists. `--mode=reference`
refuses a Drive source: we hold the copy or nothing; a bytes-free reference to something a
third party regenerates is not a citation.

**Three facts a local file does not have are recorded on the act and beside the version.**

- The file id and the exact revision the bytes were read at, as a `content.external_locator`
  row with `system = 'google-drive'`, `external_id = '<fileId>@<revisionId>'`, and
  `authority = 'authoritative'` — Drive holds the source, we hold a copy. `attach_evidence`
  now accepts an optional `source_locator` object and writes that row; the authority value is
  validated against the same four the schema allows.
- The exporter identity, as `exporter` on the action payload: `google-drive-api-v3 files.get
alt=media` for a file that has bytes of its own, or `google-drive-api-v3 files.export
mimeType=<target>` for a Google-native document. Two exporters can differ the way two
  pandocs do, so the exporter is part of the record, not a default.
- The source's own media type and modification time, as `source_media_type` and
  `source_modified_at` on the action payload; `revision_label` is the revision id.

**Google-native documents are exported at their head revision only.** Docs, Sheets and
Slides have no bytes of their own; `files.export` is the converter and does not take a
revision. A request for an older revision of a native document is refused rather than
exporting the head under an older label. Default targets are pinned in code (Docs → Markdown,
Sheets → CSV, Slides → PDF) and can be overridden per run with `--export-mime`.

**Admission is per file, never a folder sync.** `--drive=<fileId>[@<revisionId>]` is
repeatable; there is no folder argument and no listing call in the adapter.

**Read-only is structural.** The adapter authenticates as a service account with the
`drive.readonly` scope through a signed JWT; the only non-GET request it makes is the token
exchange, and the test asserts that. The key file is read through the same permission-checked
secret reader as every other secret, from `KF_DRIVE_SERVICE_ACCOUNT_FILE`.

## What this deliberately does not do

- **No `federated_source` row, no `SourceReader`.** ADR 0009 sketched Drive as a federated
  source beside git. That is the drift-checking seam for a source of record that the Fabric
  mirrors and re-reads. A Drive file is admitted once, as a copy; if it changes, someone
  ingests it again and gets a new version. The "what replaces `commit_sha`" question is
  therefore not answered because it is not asked.
- **No relaxation of `federated_reference`.** Nothing about a controlled document changes.
  Whether a Drive-origin artifact may become a controlled document is answered by the existing
  rule: it may, because by then it is a copy with a digest, and the parity criterion in ADR
  0002 is over the bytes we hold.
- **No folder sync, no listing, no writes, no user OAuth flow.**

## Verification

- `apps/api/src/ingest/drive.test.ts`: reference parsing; native export at head with the
  exporter named; non-head export refused before any request; bytes-bearing file read at the
  requested revision through the revisions endpoint; missing head revision refused; the
  request log contains no non-GET request other than the token exchange.
- `apps/api/src/ingest/plan.test.ts`: Drive items carry id and revision; a malformed reference
  is refused by name; reference mode with a Drive source is refused.
- `packages/documents/src/index.test.ts`: `attach_evidence` with `source_locator` writes
  exactly one `external_locator` row; an authority outside the four is refused.

## Consequences

- ADR 0009's status becomes "superseded by ADR 0022" for the design; its measurement of the
  federated-source cost stands and is the reason that seam was not built.
- The exporter is now recorded per version. The pandoc-pinning question ADR 0009 raised is
  narrowed to pandoc: the Drive converter's identity travels with the bytes it produced.
