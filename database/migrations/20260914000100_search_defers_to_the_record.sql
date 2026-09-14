-- migrate:up

-- The search index stops deciding who may read, and asks the record.
--
-- `search.document` denormalises `organization_id` and `classification` — "Refreshed by rebuild,
-- never edited", says the table that declares them — and `search_document_read` was evaluating
-- the caller's clearance against THAT COPY rather than against the record. The copy is refreshed
-- by `search.index_object` through the outbox, and the outbox states its own contract plainly:
-- delivery "is allowed to be late. It is not allowed to be lossy, and it is not allowed to be
-- authoritative."
--
-- Late is exactly what breaks here, because the copy WAS authoritative for visibility. Reclassify
-- a record from `internal` to `restricted` and the act commits; until the drain runs, the index
-- still carries `internal`, the policy still evaluates `internal`, and `search.document.body` —
-- which holds the assembled plaintext of every controlled document since 20260812000100 folded
-- parsed atoms into it — is still returned to anyone cleared for the old level. Nothing bounded
-- that window and nothing measured it.
--
-- The repair is not a faster drain. A window that is shorter is still a window, and one measured
-- in seconds is harder to reason about than one that cannot exist. The repair is that the derived
-- index holds no authorization input at all: it asks whether the record is visible, and
-- `core.object`'s own row security answers, live, in the same statement.
--
-- `exists` rather than a join, because the policy needs a predicate and not a row, and because
-- `core.object`'s policy does the work: a session that cannot see the record gets no row back
-- from the subquery, whatever this table remembers about it.
alter policy search_document_read on search.document
  using (exists (select 1 from core.object o where o.id = object_id));

-- The denormalised columns STAY, and this is deliberate rather than an oversight.
--
-- They are still the right way to filter and to render a hit without joining back for every row.
-- What they may no longer do is decide. A stale copy can now only make the index UNDER-inclusive
-- — a row filtered out by an application predicate that the policy would have allowed — which
-- costs a caller a result until the next drain and discloses nothing. The failure direction is
-- the safe one by construction, not by punctuality.
--
-- `@kf/search`'s own predicate also stays, for the reason `20260816000100` gave when it added
-- this policy: the table is reachable by more than that function, and the answer to a filter
-- living on one of two paths is a filter on both.

comment on policy search_document_read on search.document is
  'Visibility defers to core.object, so a reclassification takes effect in the same transaction '
  'that commits it. The denormalised organization and classification columns filter and render; '
  'they do not decide. See 20260914000100.';

-- migrate:down

alter policy search_document_read on search.document
  using (
    organization_id = core.current_organization()
    and (select rank from registry.classification where id = classification)
      <= core.current_classification_rank()
  );
