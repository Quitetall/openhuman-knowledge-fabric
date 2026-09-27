# INT-07 delta: KF harden/defensive-posture under LAMU f093d51 (2026-09-27 UTC)

**Acceptance: pending.** The owner decides whether this delta needs fresh acceptance. This pack is
evidence and accepts nothing.

## What this delta covers

The Véracier stack on 127.0.0.1:4100 now runs KF `harden/defensive-posture` (`0894130f`). Three
changes on that branch touch what the accepted packs (`../2026-09-25-clean/`) covered:

1. **Facts v2.** Non-text records are served as `kf.context-facts/v2`. The facts carry content only:
   no grants, no grant reasons, no referencing rows, no bookkeeping and no identity links. A facts
   SourceRef issued before this deploy gets one `409 KF-CTX-003`.
2. **Identification refusals are recorded.** `kf-attestor` writes them to
   `search.identification_refusal`.
3. **New route and new search.** `POST /context-source/revision` is new, and search is now one fused
   list (RRF).

## Setup

- **LAMU:** `origin/main` HEAD **`f093d51`**, clean tree. Every receipt has `source_commit f093d51`
  and `working_diff_sha256 e3b0c442…`. `kf_source.py` and `run.py` are unchanged since `75fc86d`.
- **Binaries:** `lamu` sha256 `733094ba…`. llama-server and the model are the same as in the
  earlier packs.
- **KF:** 149/149 migrations applied. The stack was not restarted by this run and there was no
  downtime.
- **Provenance:** `provenance/PROVENANCE.txt`. During the run the owner's checkout moved from
  `0894130f` to `3b4b5c89`. That change is a docs merge, and the running services were not
  restarted.

**Method.** Every run is LAMU's own `kf_source.py`, started from its own directory. It owns its own
CPU llama-server and `lamu serve`. The scripts are the ones from the clean pack. `kf-dump.sh` now
also dumps `search.identification_refusal`, without the `asker_key` value (it prints only the key's
length). `kf-persistence-scan.py` is new.

**Query re-check.** Search changed, so the queries were checked again under RRF.

- The Wassenaar query still ranks the control first for marc. With `limit 2` it adds the PDF record
  `01a0d688-4fc9…`, which is served as facts v2.
- The briefed query, with `limit 3`, gives pauline three internal PDF records, all served as facts.

## Scenarios

| # | Expected | Actual | Receipt |
|---|---|---|---|
| **S1**: marc at restricted, `--limit 2`: the text control plus one non-text record | `ok`; the package holds the text record and the facts record | **pass**. `retrieved_refs` = [control `50cb` (text), `4fc9` (PDF → facts v2)], and `compiled.json` shows both. KF recorded 1 retrieve and 18 reads (9 per ref). | `S1-allowed-text-and-facts/receipt.json` |
| **Facts v2 shape**: curl read of `4fc9` as marc | `kf.context-facts/v2`, content only | **pass**. The facts are 737 bytes; under v1 a PDF's facts were about 5.8 KB. The pack keeps only the key shape, with values replaced by their types. There is no `grant`, `access_grant`, `reason`, `need-to-know`, `created_by`/`updated_by`, `row_version`, `storage_uri` or identity field. The digest matches the ref. | `FACTS-v2-probe/facts-shape.json` |
| **S2**: pauline asks for `restricted` | `sources:access_denied`, plus a `search.identification_refusal` row | **pass**. 403 `access_denied`. Row: surface `context-source/retrieve`, failure `classification_not_granted`, `asker_kind person`, `asker_rank 3` (the rank asked for), no agent. There is no `context_disclosure` row. | `S2-above-clearance/receipt.json`, `kf-rows.csv` |
| **S3**: pauline at internal, `--limit 3`, `--forbid-ref` control, default budget | `ok`; everything served ≤ internal; the control absent; non-text records included | **pass**. Both forbid checks are true. KF side (`kf-assertion.csv`): 27 reads, 0 above internal, 0 rows for the control, served = {internal}, 3 distinct non-text records. The records' revisions are the same as in the clean pack, but their text digests changed: the facts moved from v1 to v2. With v2 facts the 6000-token default budget fits, where the clean pack needed 14000. | `S3-bound-internal/receipt.json` |
| **S3b**: pauline compiles `--forged-ref` with a facts SourceRef minted **before** the deploy | `compile:revision_mismatch` (KF-CTX-003) | **pass**. Compile returned 409 `revision_mismatch`. KF wrote one row: `read`, `KF-CTX-003`, naming `01a0d688-019a…`, revision `83802af0…`, stale v1 digest `21463fb6…`. The ref comes from the clean pack's S3 `retrieved_refs` (`pre-deploy-refs/`). A grant-change demonstration was not needed, because a pre-deploy ref was available. | `S3b-pre-deploy-facts-ref/receipt.json` |
| **REV**: `POST /context-source/revision`, through curl, as marc | `{revision, digest}`; a disclosure row with operation `revision` | **pass**. HTTP 200 `{"revision":"81da1409…","digest":"7e30d290…"}` (no text). KF row: `revision`, the control, the same revision and digest, and a corpus digest. The retrieve that minted the ref is in the same dump. | `REV-revision-route/` (`revision.body`, `revision.headers`, `kf-rows.csv`) |
| **S7**: persistence, marc, `--limit 2` (text and facts), `--audit-needle-file` | the needle reaches LAMU; LAMU keeps no file with it; KF keeps no source text and no query text beyond the declared exceptions | **pass**. All 7 LAMU checks are true, and the replay after restart is refused. The KF side is below. | `S7-persistence/receipt.json`, `kf-persistence-scan.json` |
| **S8a**: marc via the withdrawn (so undeclared) agent `knowledge-fabric-agent-int07b` | `sources:access_denied`, plus a `search.identification_refusal` row | **pass**. 403. Row: surface `context-source/retrieve`, failure `undeclared_agent`, `agent_client_id knowledge-fabric-agent-int07b`, `asker_kind person`, `asker_rank 3`. There is no `context_disclosure` row. | `S8a-agent-undeclared/receipt.json`, `kf-rows.csv` |

### S7 KF side (`S7-persistence/kf-persistence-scan.json`)

The scan used two sets of needles, both kept in 0600 files outside the repository and cited by
sha256:

- **Source needles:** 5 sentences of the control text.
- **Query needles:** the 2 queries, each raw, URL-encoded with `quote` and URL-encoded with
  `quote_plus`, 6 needles in all.

Over the whole tables (300 `context_disclosure` rows, 2 `identification_refusal` rows, 372
`recorded_query` rows):

| Place scanned | Source needles found | Query needles found |
|---|---|---|
| Every fixture log (api, attestor, worker, embed, retrieval, web, …) | 0 | 0 |
| postgres, keycloak and minio container logs | 0 | 0 |
| `search.context_disclosure`, all columns | 0 | 0 |
| `search.identification_refusal`, all columns | 0 | 0 |
| `search.recorded_query`, columns other than `query_text` | 0 | 0 |
| `search.recorded_query.query_text` | 0 | 2 of 2 queries (declared) |

The one query-text hit is the declared, owner-accepted 90-day retention. Controls:

- The source needles hit 5/5 in the corpus file and 5/5 in `search.document.body` (the lexical
  index, which keeps text by design).
- The query needles' own control is `recorded_query.query_text`.

`get-search-probe.txt` and `api-log-search-lines.jsonl` show that a `GET /search?q=…` is now logged
as `"route":"/search","query":["limit","q"]`, which carries the parameter names and no value. The
first of the two probes got `503 attestor_unavailable`: a kf-attestor socket timeout on the loaded
box, which recovered by itself. The second got 200.

## The three observations from the accepted pack, re-checked

1. **Query text in `api.log` beyond the 90-day bound.** Resolved on this branch (`7845c181`, "query
   and record text stay out of the request logs"). No query text, raw or URL-encoded, is in
   `api.log`, and the request log records the route and parameter names only.
2. **Facts include grant reasons.** Resolved: `kf.context-facts/v2` carries content only (FACTS
   probe).
3. **Identification refusals leave no disclosure row.** Changed. They still leave no
   `context_disclosure` row, but they now leave a `search.identification_refusal` row (S2, S8a).
   That row holds the organization, surface, failure, agent client, the rank asked for, and a
   pseudonymous asker key with its kind. It holds no person column and expires after 90 days.

## Retention declaration (owner decision 2026-09-25)

KF keeps query text in `search.recorded_query.query_text` for 90 days. This is owner-accepted and
covers query text only, not source text. The other tables hold no text:

- `search.context_disclosure` holds digests, ids and the pseudonymous asker key.
- `search.identification_refusal` holds the fields listed in observation 3.

Both expire after 90 days.

## LAMU observation (for the LAMU session)

LAMU at `f093d51` does not yet call `POST /context-source/revision` for its rechecks. S1, S3 and S7
show 9 full `read`s per source (`read_exact` plus the rechecks at compile and at execute). None of
them is a `revision`, so every recheck still transfers the text or facts and writes a `read` row.

## Pre-flight probes (outside the scenario windows)

These ran at 2026-09-27 02:25–02:27 UTC. Their rows are in the table totals above, but not in any
scenario dump.

- 4 `POST /context-source/retrieve` calls as marc, to re-check the queries under RRF.
- marc's master-record compile.
- The REV and FACTS probes.

## Fixture state after the runs

Nothing was granted, revoked or declared in this delta.

- **Grants:** the grants on the control are as the clean pack left them.
- **Declared agents:** `org.declared_agent` still holds three withdrawn rows and no live agent.
- **Master records:** marc and pauline compiled their own master records before each run. These
  are recorded acts.
- **Tokens:** deleted after each run.

## Secrets

A scan of this pack for the following found none of them:

- JWTs and LAMU tokens;
- persona passwords, the admin password and the agent client secrets;
- the source needles and any line of the control text of 30 characters or more.

The query strings do appear in this README, as the queries the runs used.
