# INT-07: the refusal-injection fix, deployed and re-run (2026-09-27 UTC)

**Acceptance: pending.** This pack is evidence for the owner's INT-07 delta acceptance. It accepts
nothing by itself.

## What changed

SAS §100.37 described a hole. `search.identification_refusal` recorded a refusal under any
organization that existed. So anybody holding a token the realm issued could add rows to any
organization's refusal log:

- a subject linked to no person was recorded under a pseudonym of its issuer and subject;
- a linked person naming another organization was recorded under that organization.

The owner required the hole closed, and the fix falsified, before the delta acceptance is recorded.

**Fix:** `73913f14`, migration `20260927000100_a_refusal_is_recorded_only_for_a_member`, on branch
`fix/refusal-injection` off `harden/defensive-posture` `889df1a9`.

**The rule is in the database seam**, `search.record_identification_refusal`, which is the table's
only writer. A row is written only when the verified subject resolves, through
`org.external_identity`, to a person who belongs to the organization named. Belonging means
either:

- `org.person.organization` is that organization; or
- the person holds, or held, a role assignment scoped to that organization or to one of its records.

Otherwise the seam writes nothing and returns null. The attestor's log line, with
`recorded: false`, is then the only trace. A bypassed attestor, or any caller of the seam holding
the `kf_attestor` login, gets the same null. `asker_kind` is always `person`, and a `NOT VALID`
check holds every new row to that.

## Deployment (Véracier stack, 127.0.0.1:4100)

The deployment is recorded in `provenance/pre-deploy.txt`, `provenance/migrate.log` and
`provenance/post-deploy.txt`.

1. **Migration.** At 02:55 UTC, dbmate ran from `/mnt/4tb/kf-wt-refusal` with the owner
   credential, the same path `stack.sh up` uses. The database went from 149 to 150 migrations.
2. **Build and restart.** `pnpm build`, then `KF_STACK_SKIP_BUILD=1 bash
   fixtures/veracier/stack/stack.sh restart` from that worktree, at 02:55:08–02:55:11 UTC.
   - The api, attestor, worker and web now run from `/mnt/4tb/kf-wt-refusal`.
   - The embed server and the retrieval engine were not restarted.
   - Afterwards `/ready` reported all checks ok, and the API still has `KF_RETRIEVAL_SOCKET`.

The stack now runs from the `/mnt/4tb/kf-wt-refusal` worktree. Remove that worktree only after the
stack has been restarted from another checkout.

## Setup for the LAMU runs

- **LAMU:** `f093d51`, clean worktree `/mnt/4tb/lamu-wt-int07`. The receipts have
  `working_diff_sha256 e3b0c442…`, the empty diff.
- **Binaries:** `lamu` sha256 `733094ba…`, built into `/mnt/2tb/cargo-target-kf-context`.
  llama-server and the model are the same as in the delta pack.
- **Scripts.** They are the delta pack's scripts, with these differences:
  - `kf-dump.sh` selects no `asker_key` value in any table, only its length;
  - `run-s8a.sh` writes down how S8a is run;
  - `injection-probe.mjs` and `probe.sh` are the live probe. After the runs, the probe's
    `console.log` calls became `process.stdout.write` to satisfy lint, which prints the same lines.
    `probe.sh` now keeps only the last `refused` line of `attestor.log`. The files in this pack
    were trimmed to that line, because the first version kept two.

## Results

### Live injection probe

Both probes ask `POST /context-source/retrieve` at `internal`, with marc's assignment as the acting
role.

| Probe | When | HTTP | `identification_refusal` rows in the window | Attestor log |
| --- | --- | --- | --- | --- |
| **Unlinked subject** names Véracier. A throwaway realm account (random password held in memory, no KF identity link) signs in through the login form. The account was deleted afterwards (204). | pre-deploy control | 401 `unknown_subject` | **1**: `unknown_subject`, `asker_kind subject`, under Véracier. This is the hole. | `recorded: true` |
| same, with a second throwaway account | **after the fix** | 401 `unknown_subject` | **0** | no attempt (the attestor does not try `unknown_subject`) |
| **marc names Forges Martelliere S.A.**, a real organization that is not his | pre-deploy control | 401 `role_not_held` | **1**: `role_not_held`, `person`, under Forges. This is the hole. | `recorded: true` |
| same | **after the fix** | 401 `role_not_held` | **0** | `recorded: false` |
| **The seam called directly**, with the owner credential and no attestor (`PROBE-seam-direct/result.csv`): (a) a forged subject linked to nobody, naming Véracier; (b) marc's real subject naming Forges; (c) marc naming an invented organization id | after the fix | — | **0**: each call returned null | — |

The two pre-deploy control rows, `01a0e0c9-4328…` and `01a0e0c9-4876…`, stay in the table. They
expire on 2026-12-26 with the 90-day sweep. They show the probe could fail. They are the only rows
this pack wrote that it should not have.

### S2 and S8a

Both are re-run as in `../2026-09-26-delta/`. Each is LAMU's own `kf_source.py`, started from its
own directory, and each receipt has `source_commit f093d51`.

| # | Expected | Actual | Receipt |
| --- | --- | --- | --- |
| **S2**: pauline asks for `restricted`, with `BEFORE_CLS=internal`, the S2 query, `--expect sources:access_denied` | `sources:access_denied`, plus one `identification_refusal` row, which is legitimate: she belongs to Véracier | **pass**. 403 `access_denied`. Row `01a0e0ca-bc71…`: surface `context-source/retrieve`, failure `classification_not_granted`, `asker_kind person`, `asker_rank 3`, no agent. There is no `context_disclosure` row. | `S2-above-clearance/receipt.json`, `kf-rows.csv` |
| **S8a**: marc through the withdrawn agent `knowledge-fabric-agent-int07b`, the control query, `--limit 1`, `--expect sources:access_denied` | `sources:access_denied`, plus one legitimate row | **pass**. 403. Row `01a0e0cb-02b2…`: surface `context-source/retrieve`, failure `undeclared_agent`, `agent_client_id knowledge-fabric-agent-int07b`, `asker_kind person`, `asker_rank 3`. There is no `context_disclosure` row. | `S8a-agent-undeclared/receipt.json`, `kf-rows.csv` |

**Attribution check** (`attribution-check.csv`). Each row's `asker_key` is the HMAC of the expected
person under a live pseudonym key:

- S2 → Pauline Besson: `t`;
- S8a → Marc Lefèvre: `t`.

The check compares the keys in the database and prints no key.

## Tests and falsification (in the repository, not this pack)

The tests are in `tests/permissions/attestor.test.ts`:

- An unlinked subject writes no row, whether through the attestor or with the seam called directly.
- A linked person naming another organization writes no row, whether through the socket,
  in-process (`recorded === false`) or directly.
- The same person in their own organization is written.
- `classification_not_granted`, `role_not_held` and `undeclared_agent` for a member are still
  written.

The fix was falsified twice:

- With the membership check disabled, two tests fail by name: "writes no row for a linked person
  naming an organization they do not belong to" and "records nothing for … an organization that
  does not exist".
- With the unlinked return disabled as well, "writes no row for a subject linked to no person,
  through the attestor or around it" also fails.

## Fixture state after the runs

- **Realm:** the two throwaway accounts are deleted, and no realm client was changed.
- **Declared agents:** nothing was declared or withdrawn.
- **Master records:** pauline compiled her own master record before S2. That compile is a recorded
  act.
- **Tokens:** all tokens were deleted.

## Secrets

The pack was scanned for JWTs, for all 59 persona passwords, and for the admin and agent-client
secrets. None was found. No `asker_key` value is in any file.
