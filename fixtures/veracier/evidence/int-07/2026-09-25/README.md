# INT-07 — KF source-policy proof for LAMU 0.7 (2026-09-25)

**Acceptance: pending (owner or independent reviewer).** This pack is the evidence. It accepts
nothing. Every receipt says the same thing in its `acceptance` field.

The question: when LAMU compiles and executes context over the Knowledge Fabric source, do KF's
rules still hold? The rules are retention, persistence and current authority. Every run below is an
owned-process run. LAMU's `kf_source.py` starts its own CPU `llama-server` and its own `lamu
serve`, configured with a `kf_source`. That source points at the running Véracier fixture API
(127.0.0.1:4100, branch `context-source/routes`). Each run goes sources → compile → execute and
records every status and refusal code. Each scenario directory also holds KF's own rows for the
run window. These are the `search.context_disclosure` rows, plus the `search.recorded_query` ids
and ceilings. `query_text` was never selected.

Versions and hashes are in `provenance/PROVENANCE.txt`:

- LAMU `e256e59` (origin/main), `lamu` sha256 `5f92c0c1…`.
- llama.cpp `b11190` (`fcc8915`), CPU build, sha256 `dc62c844…`.
- Qwen2.5-0.5B-Instruct Q4_K_M, sha256 `6eb923e7…`.
- KF `ab74743`, 138 of 138 migrations applied.

The KF stack was not restarted. There was no downtime.

## Local harness patch (LAMU issues, not fixed on LAMU main)

At clean `e256e59` every run fails before it reaches KF (`S1-allowed.attempt1-clean-HEAD`). The runs
use a local patch to `scripts/context-proof/kf_source.py` in a detached worktree. The patch is
`lamu-harness-local.patch`. Each receipt's `working_diff_sha256` names the exact diff it ran under:

| diff sha256 | file                                   | change                                                              |
| ----------- | -------------------------------------- | ------------------------------------------------------------------- |
| `e3b0c442…` | (none)                                 | clean HEAD                                                          |
| `bf35d232…` | `lamu-harness-local.deadline-only.patch` | control deadline now+900 s → now+280 s                            |
| `8c748439…` | `lamu-harness-local.limit.patch`         | + `--limit` (retrieval limit, default 10)                         |
| `aa97ec74…` | `lamu-harness-local.patch`               | + `--ctx-size`, `--max-input-tokens` (defaults 4096 / 3000 unchanged) |

1. **Deadline.** The harness reserves a control 900 s out. `ContextRuntime::reserve` refuses
   anything past now+300 s (`invalid_request`), so `controls` fails on every run.
2. **Budget.** The harness hard-codes `limit: 10`, `max_input_tokens: 3000` and `--ctx-size 4096`,
   and marks every source `required`. Real Véracier records do not fit. The control text record is
   1 689 tokens. A PDF record is served as canonical facts of about 5.8 KB of JSON, and one alone
   exceeds 3 000 tokens (`S3-bound-internal.attempt1-budget-limit1`). Result: `insufficient_budget`
   at compile (`S1-allowed.attempt2-budget`, `S1-allowed.attempt3-budget-limit3`).
3. The receipt does not list the retrieved refs unless the run pauses. S1 therefore pauses with a
   no-op act, and its `compiled.json` shows the control in the package.
4. The harness has no mode for a forged ref, so S4 uses `scripts/s4_forged_read.py`. It has the
   same process setup and reuses `run.py`'s helpers.
5. A LAMU observation, not a harness bug. One compile and execute reads each source from KF 9
   times: `read_exact`, then the rechecks at compile and at execute. S1, S7 and S8b show 9 reads of
   one ref, and S3 shows 27 for 3 refs. Every read is a full text transfer and a disclosure row.
   KF records all of them. LAMU should know the multiplier.
6. LAMU tags KF's uniform not-found (404) as `source_unavailable` with `retryable: true` and
   `action: retry` (S4). That keeps the uniformity. A retry cannot succeed, though, so `retry` is
   the wrong advice.

## Scenarios (all on the owner's running Véracier instance; no second instance was needed)

Personas and ids:

| Persona          | Role                               | Assignment id                          |
| ---------------- | ---------------------------------- | -------------------------------------- |
| marc.lefevre     | CISO, restricted                   | `01a0d685-127e-7eea-8a88-344340d51f03` |
| pauline.besson   | Quality engineer, internal         | `01a0d685-1cd0-78d3-9f39-9b013606056a` |
| elodie.marchetti | Records Office, recorded the grants | `01a0d684-fc6d-7a1f-ba2f-dae2bf3db478` |

The organization is `01a0d684-9975-7ea6-8f8b-27942a7289bc`. The positive control is
`01a0d688-50cb-7e2c-8958-72259f96e25a`, the restricted text extract of
`fiche_classification_aerovalve_av3000.pdf`.

Before each source lookup, `--before-sources` ran the persona's own `POST /master-record/compile`
at the classification of the run.

**Query deviation, recorded.** The briefed query `classification export aerovalve AV-3000 texte
extrait` does not retrieve the control for marc. His semantic top 10, and the top 50, are all PDF
records; the PDF of the same document ranks first and the text extract does not appear. See
`S1-allowed.attempt2-budget/kf-rows.csv`. The positive-control scenarios (S1, S5, S6, S7, S8b)
therefore use `fiche de classification export AeroValve regime Wassenaar correspondant export`.
With that query the control ranks first for marc. S2 and S3 use the briefed query.

| #   | Scenario                        | Expected                                   | Actual                                                                                                                                                                                                                                                                                                                                                                                                                       | Receipt                                    |
| --- | ------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| S1  | marc, restricted, limit 1       | `ok`; the package holds the control        | **pass**. The control is the one ref (`compiled.json`, `pause-act.log`). KF recorded 1 retrieve and 9 reads of the control (see LAMU note 5).                                                                                                                                                                                                                                                                                | `S1-allowed/receipt.json`                  |
| S2  | pauline asks at `restricted`    | `sources:access_denied`                    | **pass**. KF's attestor refused with 401 `classification_not_granted`, which LAMU surfaces as `access_denied`. Nothing reached a transaction, so there is no `context_disclosure` or `recorded_query` row. The attestor log line is in `kf-attestor-refusal.jsonl`.                                                                                                                                                          | `S2-above-clearance/receipt.json`          |
| S3  | pauline at `internal`, limit 3, `--forbid-ref` control | `ok`; nothing above internal; control absent | **pass**. `forbidden_refs_not_retrieved` and `forbidden_refs_not_in_package` are both true. KF-side (`kf-assertion.csv`): 27 reads, 0 above internal, 0 rows naming the control, and the only classification served was `internal`.                                                                                                                                                                                         | `S3-bound-internal/receipt.json`           |
| S4  | pauline compiles from forged refs: the control (marc's exact SourceRef) and a random uuid | both `source_unavailable`; KF 404 bodies byte-identical | **pass**. Both LAMU compiles returned 503 `source_unavailable`, and the responses are identical apart from the request's own `operation_id`. Raw curl as pauline: both reads got `HTTP 404` with body `{"error":"not_found","rule":"KF-CTX-001"}`, sha256 `189be408…` for both (`curl-read-*.body`). KF wrote `KF-CTX-001` rows with no object, revision or text digest. | `S4-not-found-uniform/receipt.json`        |
| S5  | marc, pause, then the Records Office adds a grant on the control | `revision_mismatch`                        | **pass**. Execute got 409, and KF recorded `KF-CTX-003` against the compiled revision `b9cd4bff…`. The act was `grant_access` to pauline. A record's master-record payload includes its `org.access_grant` rows, so the revision moved while the text stayed the same. KF has no act that adds a version to an existing artifact. The added grant was revoked straight after (`restore.log`).                                     | `S5-revision-moved/receipt.json`           |
| S6  | marc, pause, then the Records Office revokes marc's grant `01a0d68b-92d5…` | `access_denied`                            | **pass**. Execute got 403, and KF recorded `KF-CTX-002` (`grant_withdrawn`). His master record had included the record, so this was 403 rather than 404. Restored by `grant_access` through the same Records Office path. The new grant is `01a0da5e-deb1…` with the original reason (`restore.log`, `grants-after-restore.csv`). S7 then read the control as marc again.                                                         | `S6-grant-revoked/receipt.json`            |
| S7  | S1 again with `--audit-needle-file` | the needle reaches LAMU; no file keeps it; the package does not survive a restart | **pass**. All LAMU checks are true: `needle_reached_lamu`, no hits after execute or after restart, `package_does_not_survive_restart` (503 `source_unavailable`), and `scanner_detects_planted_needle`. KF side, over 5 needles (`kf-needle-scan.json`, `kf-container-log-scan.json`): 0 hits in every file under the fixture's `logs/` (api, attestor, worker, embed, retrieval, web, …); 0 in `search.context_disclosure` (all 144 rows, every column); 0 in `search.recorded_query` (all 356 rows); 0 in the postgres, keycloak and minio container logs. Positive controls hit 5 of 5: the corpus text file, and `search.document.body` (KF's lexical index holds text by design). | `S7-persistence/receipt.json`              |
| S8a | marc via the agent client, **undeclared** | refused                                    | **pass**. KF's attestor refused with 401 `undeclared_agent`, surfaced as `sources:access_denied`, with no KF rows. The token carried `act.client_id = azp = knowledge-fabric-agent` (`exchange.log`).                                                                                                                                                                                                                         | `S8a-agent-undeclared/receipt.json`        |
| S8b | the same, after `kf declare-agent` | `ok`, with agent participation recorded | **pass**. All 10 KF rows (1 retrieve, 9 reads) carry `agent_participation = knowledge-fabric-agent`. The declaration was withdrawn right after (`S8-declare-agent.log`, `S8-declared-agent-after.csv`).                                                                                                                                                                                                                     | `S8b-agent-declared/receipt.json`          |

Failed runs are kept under `*.attemptN-*` names:

- **S1 attempt 1:** deadline bug.
- **S1 attempts 2–3:** budget.
- **S3 attempt 1:** budget.
- **S4 attempt 1:** the S4 driver had the same 900 s deadline.
- **S4 attempt 2:** the driver's check compared whole LAMU refusal bodies, which carry the request's
  own `operation_id`. The check now compares the body without that id. The refusals themselves were
  already `source_unavailable` for both refs.

## Retention declaration (owner decision 2026-09-25)

KF keeps **query text** in `search.recorded_query.query_text` for 90 days (`expires_at =
recorded_at + 90 days`, swept by the worker). The owner declared and accepted this KF-side retention.
It covers query text, not source text. S7 finds no source text in that table.
`search.context_disclosure` holds no text column. It records the corpus digest, record, revision,
text digest, the tagged digest of the reference list, the declared agent and a pseudonymous asker
key. It expires after 90 days as well.

**Observed beyond the declaration.** The API's request log (`logs/api.log`) keeps the URL of every
`GET /search?q=…`, and so keeps its query text, outside that sweep. The six such lines came from
this session's pre-flight `/search` probes; the web app searches the same way. The context-source
routes are `POST`s, and their bodies are not logged. Nothing in this pack depends on it, but the
declared 90-day bound on query text does not cover that log.

## Refusals and where they are recorded

- `KF-CTX-001`, `-002` and `-003` are rows in `search.context_disclosure`, written in the deciding
  transaction.
- Refusals at identification (`classification_not_granted` in S2, `undeclared_agent` in S8a) happen
  before any principal is bound. They leave no database row. The only record is one line in
  `attestor.log`, which carries the organization and the failure, not the person.

## Pre-flight probes (not scenarios)

These ran at 20:24–20:33 UTC and at 20:53:18 UTC, outside every scenario window. The windows' dumps hold only the runs' own rows. The probes were:

- `POST /master-record/compile` for pauline.
- Two raw `POST /context-source/retrieve` calls as pauline, at internal (200) and restricted (401).
- `GET /search` probes as marc and pauline. These found the query deviation above and located the
  control's rank.
- One `llama-server /tokenize` of the control text on a private port.

They added `recorded_query` rows and the api.log URLs noted above.

## Fixture state after the runs

- **marc's read grant on the control.** It was revoked (S6) and re-granted as `01a0da5e-deb1…`. The
  live grant set on the control again equals the original: marc and `01a0d684-d6cf…`. The revoked
  rows stay; rows are never deleted.
- **pauline.** She was granted on the control for S5 and revoked 9 s later. The revoked row stays.
- **Revision.** The control's master-record revision is no longer `b9cd4bff…`, because its payload
  includes those grant rows. Master records compiled before 20:59 UTC are stale for it until
  refreshed; the web app refreshes on demand.
- **Declared agent.** `org.declared_agent` has one row, `knowledge-fabric-agent`, withdrawn at
  21:04:51 UTC. Rows are never deleted, so functionally there are again no declared agents.
- **Master records.** marc and pauline compiled their own master records before each run. These
  acts are recorded in the audit chain.

## What was not run

- A throwaway second instance. S5 and S6 were reversible through the API, so they ran on the
  owner's instance and were restored.
- An S5 variant that moves the record's text. KF has no act that adds a version to an existing
  artifact, so the revision was moved through the record's grants.

## Secrets

This pack contains no passwords, tokens, or source text; a scan for JWTs, LAMU tokens, persona and
admin passwords, the needles and any 30+ character line of the control text found none.

- **Needles.** They live outside the repository (0600). The harness needle has sha256
  `0274a9e5…`; the 5-needle KF scan file has sha256 `0615ca6f…`.
- **Tokens.** Bearer tokens were minted into 0600 files in the session scratchpad and deleted after
  each run.
- **Database credential.** The one credential in these scripts is the fixture database's public
  development password from `docker-compose.yml`.

## Scripts (`scripts/`)

| Script                    | What it does                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `mint.mjs`                | Mints a persona token through the realm's PKCE login form.                                                |
| `kf-act.mjs`              | Makes one API request as a persona.                                                                       |
| `run-scenario.sh`         | Runs one scenario: token refresh loop, harness, row dump, copy into the pack.                             |
| `pause_act.py`            | Waits for `compiled.json`, checks the control is in the package, performs the act, then writes `continue`. |
| `records-office-act.sh`   | Performs a grant or revoke as elodie.marchetti.                                                           |
| `kf-dump.sh`              | Dumps KF's rows for a run window.                                                                         |
| `s4_forged_read.py`       | S4 driver.                                                                                                |
| `kf-needle-scan.py`       | S7 KF-side scan.                                                                                          |
| `exchange-agent-token.py` | S8 standard token exchange.                                                                               |
