# INT-07 — KF source-policy proof for LAMU 0.7, clean re-run (2026-09-25)

**Acceptance: pending (owner or independent reviewer).** This pack is evidence only. It accepts
nothing, and every receipt's `acceptance` field says the same.

This re-runs `../2026-09-25/` against LAMU main **`75fc86d`**, with **no local harness patch**. Every
receipt has `source_commit 75fc86d…` and `working_diff_sha256 e3b0c442…`, the SHA-256 of an empty
diff. The first pack stays as it is.

`75fc86d` carries the harness fixes from `2816977`:

- the control deadline is 280 s;
- `--pause-seconds`, `--limit`, `--ctx-size`, `--max-input-tokens` and `--optional-sources`;
- `retrieved_refs` in every receipt;
- `--forged-ref` together with `--expect compile:CODE`.

It also carries `6874943`: a KF 404 now surfaces as `missing_required_source` (HTTP 422, not
retryable).

Provenance is in `provenance/PROVENANCE.txt`:

- `lamu` sha256 `06c95535…`, built with Rust 1.89.0 into `/mnt/2tb/cargo-target-kf-context`;
- llama.cpp b11190 (`fcc8915`), a CPU build, sha256 `dc62c844…`;
- Qwen2.5-0.5B-Instruct Q4_K_M, sha256 `6eb923e7…`;
- the KF services run from `ab74743`'s build; 138 of 138 migrations are applied.

The KF stack was not restarted. There was no downtime.

## Method

Each run is an owned-process run of LAMU's `kf_source.py`, started from its own directory. The
harness starts its own CPU `llama-server` and `lamu serve`, and gives them a `kf_source` that points
at the Véracier API on 127.0.0.1:4100. All runs use the owner's running instance.

Before each source lookup, `--before-sources` runs the persona's own `POST /master-record/compile`.
`scripts/run-scenario.sh` then does three things for each run:

- keeps the persona's 300 s token fresh, in a 0600 file outside the repository that is deleted
  afterwards;
- dumps KF's rows for the run window: `search.context_disclosure`, and `search.recorded_query` ids
  and ceilings (`query_text` is never selected);
- copies the text-free artifacts into the pack.

**Personas:**

| Persona | Role | Clearance |
|---|---|---|
| marc.lefevre | — | restricted |
| pauline.besson | — | internal |
| elodie.marchetti | Records Office | — |

**Control record:** `01a0d688-50cb-7e2c-8958-72259f96e25a`, the restricted text extract of
`fiche_classification_aerovalve_av3000.pdf`.

**Queries.** Wherever the control has to be retrieved (S1, S5–S8), the query is `fiche de
classification export AeroValve regime Wassenaar correspondant export`. The briefed query does not
put the control in marc's semantic top 50; see the first pack. S2 and S3 use `classification export
aerovalve AV-3000 texte extrait`.

**Budget flags.** These are harness flags now, not a patch:

- S1 and S5–S8 use `--limit 1` with the default budget.
- S3 uses `--limit 3 --ctx-size 16384 --max-input-tokens 14000`, because three real PDF records do
  not fit the 6000-token default.

## Scenarios

| #   | Expected | Actual | Receipt |
| --- | -------- | ------ | ------- |
| S1 allowed: marc at restricted | `ok`; the package contains the control | **pass**. `retrieved_refs` = [control] and `compiled.json` agrees. KF logged 1 retrieve and 9 reads of the control. | `S1-allowed/receipt.json` |
| S2 above clearance: pauline asks for restricted | `sources:access_denied` | **pass**. Retrieve returned 403 `access_denied`. The attestor refused with `classification_not_granted` (`kf-attestor-refusal.jsonl`). There is no disclosure or query row. | `S2-above-clearance/receipt.json` |
| S3 bound at internal: pauline at internal, `--forbid-ref` control | `ok`; everything served ≤ internal; control absent | **pass**. `forbidden_refs_not_retrieved` and `forbidden_refs_not_in_package` are both true. On the KF side (`kf-assertion.csv`): 27 reads, 0 above internal, 0 rows for the control, served classifications = {internal}. When pauline reads the restricted control directly, she gets `missing_required_source` (S4 control run). | `S3-bound-internal/receipt.json` |
| S4 not-found is uniform: pauline compiles `--forged-ref` of (a) the control's real SourceRef, (b) a random uuid | both `compile:missing_required_source`, same outcome; KF 404 bodies byte-identical | **pass**. Both runs gave compile 422 `missing_required_source`, and the observations are equal apart from the forged ref itself. In KF, each run wrote one `KF-CTX-001` row with no object, revision or digest. Raw curl as pauline (`S4-not-found-uniform/`): both returned `HTTP/1.1 404` with body `{"error":"not_found","rule":"KF-CTX-001"}`, sha256 `189be408…` for both (`cmp` identical); their KF rows are in `kf-rows-curl.csv`. | `S4-forged-control/receipt.json`, `S4-forged-random/receipt.json` |
| S5 revision moved: during the pause, the Records Office grants pauline read on the control | `revision_mismatch` | **pass**. Execute returned 409, and KF logged `KF-CTX-003` against the compiled revision `646b94a1…`. The grant `01a0dab9-c9d3…` was revoked straight after (`restore.log`). | `S5-revision-moved/receipt.json` |
| S6 grant revoked: during the pause, the Records Office revokes marc's live grant `01a0da5e-deb1…` | `access_denied` | **pass**. Execute returned 403, and KF logged `KF-CTX-002`. The grant was restored through the same path as `01a0daba-d7e1…`, with the original reason (`restore.log`, `grants-after-restore.csv`). S7 then read the control as marc again. | `S6-grant-revoked/receipt.json` |
| S7 persistence: S1 again with `--audit-needle-file` | the needle reaches LAMU; no file keeps it; the package does not survive a restart | **pass**. All seven checks are true, including `scanner_detects_planted_needle`, and the replay after restart returned 503. On the KF side, 5 needles were searched for (`kf-needle-scan.json`, `kf-container-log-scan.json`): 0 hits in every fixture log (api, attestor, worker, embed, retrieval, web, …), 0 in `search.context_disclosure` (216 rows, every column), 0 in `search.recorded_query` (362 rows) and 0 in the postgres, keycloak and minio container logs. Both controls hit 5/5: the corpus file, and `search.document.body` (the lexical index keeps text by design). | `S7-persistence/receipt.json` |
| S8a delegated token, agent **undeclared** | refused | **pass**. Retrieve returned `sources:access_denied`; the attestor refused with `undeclared_agent`. There is no KF row. The token carried `act.client_id = azp = knowledge-fabric-agent`. | `S8a-agent-undeclared/receipt.json` |
| S8b delegated token, agent declared | `ok`, with agent participation on every row | **pass**. Client `knowledge-fabric-agent-int07b` was registered by `fixtures/veracier/stack/stack.sh agent-client` (below), declared with `kf declare-agent`, exchanged for marc (`act.client_id = azp = knowledge-fabric-agent-int07b`, `exchange.log`), and withdrawn after the run (`declare-agent.log`). Retrieve, compile and execute were all ok. All 10 KF rows (1 retrieve, 9 reads of the control) carry `agent_participation = knowledge-fabric-agent-int07b` (`kf-rows.csv`). | `S8b-agent-declared/receipt.json` |

### S8b attempts kept as evidence

- **`S8b-agent-declared.not-run-redeclare-refused/`.** `kf declare-agent` refused to re-declare
  `knowledge-fabric-agent`, the client withdrawn after the first pack. The refusal was *"a withdrawn
  agent is not re-declared under the same client id. Register a new client."* The delegated token
  was then refused 401 `undeclared_agent` at `before-sources`. This shows that a withdrawal holds.
- **`S8b-agent-declared.aborted-int07-output-dir-reused/`.** This was my error, not a KF or LAMU
  finding. The first new client, `knowledge-fabric-agent-int07`, was declared, but the harness
  refused to start because its output directory existed from the earlier attempt
  (`FileExistsError`). The agent was then withdrawn at 22:48:16 UTC, and no request reached KF with
  its token: the window's dump is empty. Because a withdrawn id cannot be declared again, the run
  that passed used a second client, `knowledge-fabric-agent-int07b`.

### Registering a fixture agent client (reproducible)

`fixtures/veracier/stack/stack.sh agent-client <id>` runs `stack/agent-client.mjs` against the
loopback realm only. The client is built as ADR 0035 and `docs/deployment/identity-and-login.md`
describe, with the committed realm's `knowledge-fabric-agent` as the template:

- it is confidential, with standard token exchange on;
- it has no browser flow, no direct grant and no service account, and `fullScopeAllowed` is false;
- it carries a hard-coded `act.client_id` equal to its own id, and the `knowledge-fabric-api`
  audience;
- `knowledge-fabric-web` gains an audience mapper naming the new client.

The script is idempotent. It writes the secret to
`~/.local/state/kf-veracier/agent-clients/<id>.secret` (0600) and never prints it. Declaring the
client to KF stays a separate owner-credential act, `kf declare-agent`.

## Retention declaration (owner decision 2026-09-25)

KF keeps **query text** in `search.recorded_query.query_text` for 90 days. The worker sweeps it at
`expires_at` = `recorded_at` + 90 days. This is declared, owner-accepted retention of query text
on the KF side. It does not cover source text; S7 finds no source text in that table.

`search.context_disclosure` has no text column. Its rows carry the corpus, record, revision, text
digest, reference-list digest, declared agent and a pseudonymous asker key, and expire after 90
days.

## Recorded observations (KF)

1. **Query text in `api.log` beyond the 90-day bound.** The API request log keeps the URL of every
   `GET /search?q=…`, and so the query text, outside the sweep. The context-source routes are
   POSTs and their bodies are not logged. In this session those URLs came from pre-flight probes.
   The web app searches the same way.
2. **Facts include grant reasons.** A record that is not text is served as its canonical facts,
   and those include its `org.access_grant` rows with their reasons. For example: "Need-to-know
   matrix …: *title* (*entity*) reads *path*". This is why PDF records are large, about 5.8 KB of
   JSON. It is also why an access-grant change moves a record's revision, which is how S5 moves it.
3. **Identification refusals leave no disclosure row.** `classification_not_granted` (S2) and
   `undeclared_agent` (S8a) happen before a principal is bound. The only trace is one
   `attestor.log` line naming the organization and the failure, not the person.

## Recorded observations (LAMU, for the LAMU session)

- **Nine reads per source.** One compile plus one execute makes 9 KF reads of each source: the
  read, then the rechecks at compile and at execute. S1 and S7 show 9 reads of 1 ref, and S3 shows
  27 reads of 3 refs. Each read is a full text transfer and a disclosure row.
- **Restart replay refusal.** After a restart, the replay is refused `source_unavailable` (503,
  retryable). That is the package cache missing, not KF. `6874943` affects only KF 404s.

## Fixture state after the runs

- **Grants on the control:**
  - Live grants are marc (`01a0daba-d7e1…`) and `01a0d684-d6cf…`, the same principals as
    originally.
  - Revoked rows stay as evidence: marc's `01a0d68b-92d5` and `01a0da5e-deb1`, and pauline's
    `01a0da5d-9347` and `01a0dab9-c9d3`.
- **Control revision.** It has moved, because its revision covers grant rows. Master records
  compiled before 22:41 UTC are stale for the control until refreshed.
- **Declared agents.** `org.declared_agent` holds three rows, all withdrawn, so no agent is live
  (`S8-declared-agent-after.csv`):
  - `knowledge-fabric-agent`, withdrawn 21:04:51;
  - `knowledge-fabric-agent-int07`, withdrawn 22:48:16;
  - `knowledge-fabric-agent-int07b`, withdrawn 22:49:16.
- **Realm clients.** The realm keeps the test clients `knowledge-fabric-agent-int07` and `-int07b`,
  and `knowledge-fabric-web` keeps one audience mapper for each. They are harmless while undeclared,
  because the attestor refuses them. Their secrets are 0600 files in the fixture state.
- **Master records.** marc and pauline compiled their own master records before each run. These
  are recorded acts.

## Secrets

The pack contains no passwords, tokens or source text. A scan for JWTs, LAMU tokens, persona and
admin passwords, the needles, and any line of the control text of 30 characters or more found
none.

- The needles are 0600 files outside the repository: the harness needle has sha256 `0274a9e5…`;
  the 5-needle scan file has `0615ca6f…`.
- The one credential in the scripts is the fixture database's public development password from
  `docker-compose.yml`.

## Scripts (`scripts/`)

The scripts are the same as in the first pack. `s4_forged_read.py` is dropped, because the harness
now does S4 itself.

- `mint.mjs` (PKCE login into a 0600 token file)
- `kf-act.mjs`
- `run-scenario.sh`
- `pause_act.py`
- `records-office-act.sh`
- `kf-dump.sh`
- `kf-needle-scan.py`
- `exchange-agent-token.py` (optional third argument: an agent client id, whose secret it reads
  from the fixture state)
