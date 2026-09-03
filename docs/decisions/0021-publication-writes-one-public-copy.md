# A publication writes exactly one public copy, and unpublishing is a recorded failure, not a delete

**Status:** accepted — implemented 2026-09-02; builds on ADR 0006, ADR 0016, ADR 0017
**Date raised:** 2026-09-02
**Date decided:** 2026-09-02
**Decision owner:** technical authority
**Scope:** what a publication is on the storage side, where public bytes live, what act writes
them, and what "unpublish" means

## The problem, measured

The institutional half of publication already existed and was strict: `publish_document_view`
requires an accepted, qualified compilation run, an effective controlled document at or above
the view's classification, and a registered publication target, and the public route serves
only an Ed25519-signed `kf-publication-v1` manifest over that act. What it never did was put
bytes anywhere. ADR 0017 allowed a `public_copy` location role and wrote none, deferring "the
publication boundary" — which turned out to be one column and one write, once it was clear the
act already existed.

## Decision

**A store may be declared public; a target may name one.** `content.artifact_store.public`
says bytes written there are outside the product-instance boundary (ADR 0006).
`content.document_publication_target.public_store_id` names the public store a target
publishes bytes into; a trigger refuses a target naming a store that is not public. A target
without one publishes through the signed public route only, exactly as before.

**The publication act writes exactly one public copy.** When the target names a public store,
`publish_document_view` — after recording the publication — copies the compiled view's bytes
from the working store into the public store with create-only semantics, records a
`public_copy` location under that act, and verifies what landed; a copy that does not verify
refuses the publication. The database enforces the "only" in two directions: a `public_copy`
row recorded by any act other than `publish_document_view`, or into any store not declared
public, is refused. A target that names a store this instance cannot reach refuses the
publication by name (`KF-DOC-PUBLISH-007`) rather than publishing the manifest without the
bytes. `publish_document_view` is a `requires: act` action (ADR 0016).

**Unpublish is the document leaving `effective`.** The public route already refuses a
publication whose controlled document is not effective. When a document is superseded or
withdrawn — both `requires: act` — a trigger marks every public copy of its publications with a
recorded verification failure that names the state it moved to, under the act that moved it.
Nothing is deleted: the bytes stay as evidence of what was public and until when, and
`readVersionBytes` will not serve a copy whose last verification failed.

## What this does not decide

- **Serving from the public store.** The signed public route still serves from the working
  store; whether a CDN or bucket listing in front of the public store is a second delivery path
  is a deployment question with the host.
- **Re-publication after supersession.** A superseding revision is a new publication act with
  its own copy; the old copy's failure record stands.
- **Retention of public copies.** Nothing removes them; retention (ADR 0004) will need its own
  act.

## How this is held

`packages/documents/src/index.test.ts`, the document action chain against a real database: a
target naming a non-public store is refused; publishing to a target naming the public store
writes one verified `public_copy` under the publication act and the bytes are in the public
store; a `public_copy` inserted under any other act is refused; superseding the document marks
the copy `unpublished: …` with no digest, and the bytes remain.
