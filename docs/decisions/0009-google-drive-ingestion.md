# Google Drive ingestion is deferred until after v1.0

**Status:** superseded by [ADR 0022](0022-drive-as-external-source-holder.md) on 2026-09-02 — ingestion was built as a per-file copy with the revision and exporter recorded, NOT as a federated source; the measurement below is why that seam was not built
**Date raised:** 2026-08-24
**Date decided:** 2026-08-24
**Decision owner:** technical authority
**Scope:** whether the Fabric should read documents out of Google Drive, when, and what
shape that takes when it does
**Decision:** not before a host is commissioned and v1.0 is tagged. The design below is
recorded because the expensive part of it is already known, and because one of its
conclusions is uncomfortable enough to be worth writing down before anyone starts.

---

## Why this is deferred rather than scheduled

It is a feature on a system nobody is running. Every criterion in
[ADR 0004](0004-production-release.md) that is still open queues behind one fact — no host
has ever been commissioned — and criterion 4 carries a 7-day floor that cannot start
counting until one is. Drive ingestion adds no day to that clock and removes none.

There is also an upstream question it would inherit. `docs/deployment/private-host.md`
records that the pandoc version is unpinned and that two hosts running different pandocs can
produce different atoms for the same source. Drive's exporter is a second unpinned converter
in the same path. Settling one while the other is open answers half a question.

## What was measured

The claim this ADR was expected to make — "a Drive file needs no schema change" — is
**half true**, and the half that is false is the expensive half. Both halves were read
rather than assumed.

**The document-holder chain is ready.** `content.document_source_holder` already admits a
non-git, non-fabric source:

```sql
holder_kind text not null check (holder_kind in ('fabric_native', 'git', 'external'))
```

and its `document_source_holder_one_authority` constraint requires, for `external`, exactly
`external_authority` and `external_revision` non-empty and everything git-shaped null.
Both are free text. `content_digest` is a required `^[0-9a-f]{64}$`. So a Drive file maps
directly — `external_authority = 'google-drive:<fileId>'`,
`external_revision = '<revisionId>'`, `content_digest` over the exported bytes — with no
migration. The linear-chain constraints mean each re-export is a new Holder row pointing at
the previous one, which is the correct shape for a source that changes.

**The federation seam is not ready, and it is git-shaped in the database, not just in the
types.** `quality.federated_reference` declares:

```sql
commit_sha text not null check (commit_sha ~ '^[0-9a-f]{40}$')
```

`SourceReader.read(commitSha, path)` takes the same thing, and `recordReference` rejects
anything that is not 40 hex characters with `FederationRejected('not_pinned', …)` — "a
branch is not a citation". A Drive `revisionId` is an opaque token, not a sha. It cannot be
stored there today, and the fix is a migration that relaxes a CHECK which exists on purpose.

So the work is not "implement a `SourceReader`". It is "decide what a citation means when
the cited system has no commits", and then implement a `SourceReader`.

## The uncomfortable part

`checkDrift` treats a digest that no longer matches at a pinned commit as a hard alarm, and
the code says why in as many words: content cannot change at a pinned commit, so "the
history was rewritten, or this is not the source it claims to be". `recordReference` refuses
the same event outright rather than upserting past it. That severity is correct for git and
is the reason the module exists.

**On Drive, that exact signal fires for a benign reason.** A Google Doc has no canonical
bytes. What is hashed is whatever the exporter produced at the moment of reading, and Google
can change the exporter with nobody editing the document. Digest changed, revision unchanged
is therefore two different events wearing one face:

| revision  | digest    | means                                               |
| --------- | --------- | --------------------------------------------------- |
| changed   | changed   | somebody edited the document — a real revision      |
| unchanged | changed   | the exporter moved — nothing was edited             |
| changed   | unchanged | an edit that survived export identically — possible |

Only the second is new, and it is the one the current design cannot express. Both fields
must therefore be recorded and compared **independently**, and exporter drift must be
reported as its own finding rather than as `digest_mismatch`.

The tempting shortcut is to soften `digest_mismatch` so Drive stops crying wolf. That must
not happen: the alarm is shared with git, where it means a rewritten history, and softening
it there to accommodate a different source's semantics would trade a real detection for a
quieter log. If Drive needs a weaker signal, Drive gets a different signal — not the same one
turned down.

## Shape, when it is built

- **Admission is an allowlist of specific files, never a folder sync.** PHI must never enter
  the Fabric in any form, and bank details, tax identifiers and payroll secrets are never
  stored in it. A recursive sync makes the boundary depend on what somebody dropped in a
  folder, which is not a control. An allowlist makes each admitted document a decision.
- **Read-only is structural, not conventional.** `quality.federated_source` carries a
  `writable` column defaulting to false, and a `federated_source_read_only` CHECK that
  requires it to be false. A Drive source is therefore read-only by the same constraint that
  already binds every other source, and making it writable would be a reviewed migration.
- **One seed row** in `quality.federated_source`, `id = 'google-drive'`.
- **A `SourceReader` implementation** beside `GitSourceReader` in
  `packages/integration/src/git.ts`. Note that `SourceReader.read` will need widening or a
  sibling interface, since its first parameter is a commit sha by name and by contract.
- **The export format is part of the citation.** Two hosts asking Drive for different export
  MIME types get different bytes for one document, so the format belongs in the recorded
  reference rather than in a caller's default — the same argument that puts `parserVersion`
  in the atoms today.
- **Credentials are host state.** A service-account key follows the per-role
  `/etc/kf/<role>/` 0600 pattern in `deploy/systemd/README.md`; it is never in the
  repository, and `~/.config/lamu/api-keys.env` is not a deployment mechanism.

## What this record does not settle

- **What replaces `commit_sha` for a non-git source.** Widening the column, adding a
  discriminated `revision_kind`, or giving external sources their own table are all
  defensible. The choice determines whether `checkDrift` stays one function or becomes two.
- **Whether Drive documents may become controlled documents at all**, or only citable
  references. A controlled document whose bytes are regenerated by a third party on a
  schedule nobody controls is in tension with decision 0002's parity criterion, which
  requires byte-identical compilation. This is the question to answer first, because a "no"
  makes most of the above unnecessary.
- **Whether the same seam should serve other external systems.** If it should, building it
  Drive-first risks a Drive-shaped abstraction; if it should not, generality is wasted work.
