# Private-host dogfood deployment

This is the deployment contract for the first shared dogfood host. It is not a production
claim, a commissioning record or evidence of institutional readiness. The host may serve
records only after every required control below has been exercised with evidence from that
host.

## Boundary

- The only permitted profile is `KF_DEPLOYMENT_PROFILE=dogfood`.
- Application processes run with `NODE_ENV=production`.
- A reverse proxy terminates TLS before either the API or web process; the API receives
  `KF_TLS_TERMINATED_UPSTREAM=1` and listens on a private interface.
- Keycloak authenticates the person. PostgreSQL remains the authority for identity links,
  current role assignments, classification and action permission.
- The workstation build is promoted byte-for-byte. The private host does not run `pnpm build`,
  resolve a newer dependency or substitute source from another checkout.
- The fixed `KF_DEV_*` caller is absent. Setting `KF_ALLOW_FIXED_IDENTITY=1` cannot enable it in
  this profile.

The Next.js dogfood path uses OIDC authorization code with PKCE, an encrypted owner-only-file
session key and bearer forwarding to the API. Repository fixtures exercise that boundary; they
are not evidence against a real Keycloak realm. The web unit remains blocked from shared use
until the host's realm, audience mapper, subject links and role assignments pass preflight.

## Target topology

```text
browser or API client
        |
        | HTTPS
        v
reverse proxy ----> Keycloak (issuer, login, MFA/session policy)
        |
        +----------> API :4000 ----> PostgreSQL 18
        |                    \-----> S3-compatible object store
        |
        +----------> Web :3000 ----> API :4000 (server-side bearer forwarding)

worker ---------------------> PostgreSQL 18
checkpoint signer ----------> PostgreSQL 18 + isolated signing key
```

PostgreSQL, object storage and Keycloak may begin on the same private host for bounded dogfood,
but they need independent credentials, backups and off-host copies. The workstation Compose
file is a dependency rehearsal with public credentials and Keycloak `start-dev`; it is never
copied onto the host as deployment configuration.

## Supported host platform

The current private-host artifacts support one platform contract: a GNU/FHS Linux host using
systemd. They are not portable deployment artifacts for macOS, BSD, Windows, non-systemd Linux
or an arbitrary container image. Release and verification scripts rely on Bash plus GNU
userland behavior such as `readlink -f`, `realpath -ms`, `stat -Lc`, `find -printf`,
`sha256sum`, `install` and FHS locations under `/opt`, `/etc`, `/var/lib`, `/run` and
`/usr/bin`.

Install a Node.js version allowed by `package.json` (`>=24.18.1 <25`) as the real executable
`/usr/bin/node`. Service units and Liminal runtime assembly/verification invoke that absolute
path; an `nvm`, `asdf`, shell alias or PATH-only Node installation does not satisfy the host
contract. Install bubblewrap as `/usr/bin/bwrap`, and qualify the kernel and systemd unit with
the user, mount, PID, IPC, network, UTS and cgroup namespaces plus mount syscalls permitted by
`kf-worker.service`.

The packaged Liminal compiler must be a native ELF executable for the target architecture and
must load with its nonempty, reviewed interpreter/shared-library closure on that host. Linux
procfs must provide `/proc/self/fd/<n>` descriptor semantics: the worker opens and hashes the
compiler and every runtime file, passes those descriptors to bubblewrap, and mounts the pinned
descriptors inside the sandbox. A host that hides or emulates those descriptors is unsupported.

Every runtime-closure entry must be a normalized absolute regular-file path below exactly one
of `/lib/`, `/lib64/`, `/usr/lib/` or `/usr/lib64/`. The verifier rejects other roots,
directories, an ambient `/usr` mount, non-root ownership, group/other-writable files and closure
bytes that differ from the release manifest. Multiarch subdirectories are permitted only as
descendants of those approved roots. The workstation build architecture, target ELF
architecture and reviewed runtime closure therefore have to match.

## Build once on the workstation

Use Linux with the same architecture as the target and the pinned Node.js and pnpm versions.
Build in a newly created disposable worktree at the exact commit intended for dogfood. Do not
reuse an interactive checkout: Git's normal dirty check omits ignored `dist/`, `.next/` and
dependency trees, so it cannot prove runtime bytes are fresh. Before installing anything, the
fresh worktree must contain no tracked, untracked or ignored entry beyond committed content:

```sh
source_root="$(git rev-parse --show-toplevel)"
release_commit="$(git rev-parse HEAD)"
build_parent="$(mktemp -d)"
git -C "$source_root" worktree add --detach "$build_parent/source" "$release_commit"
cd "$build_parent/source"
test -z "$(git status --porcelain=v1 --untracked-files=all --ignored)" || {
  echo 'refusing release build from a nonempty disposable worktree' >&2
  exit 1
}
pnpm install --frozen-lockfile
pnpm gate
```

`pnpm gate` runs every check CI runs, in CI's order, ending with `pnpm build` — so the release
bytes below are built by the same command that gates them. It replaces the five checks
previously listed here, which were five of the seven: the two ontology gates were missing, so a
release could be cut from a tree whose committed `generated/` did not match its `ontology/`.
`tests/deployment/gate-parity.test.ts` keeps the command and `ci.yml` in agreement.

After those gates pass, assemble runnable package directories from those already-built bytes.
`--legacy` is required by repository's current non-injected pnpm workspace layout.
`--deploy-all-files` is required because root `.gitignore` excludes `dist/` and `.next/` from
package packlists; without it release silently omits runtime. These are packaging modes, not
permission to change lockfile.

```sh
release_id="$(git rev-parse --short=12 HEAD)"
release_root="release/knowledge-fabric-$release_id"
test ! -e "$release_root" || {
  echo "refusing to reuse $release_root" >&2
  exit 1
}
install -d "$release_root/apps" "$release_root/packages"

pnpm --filter @kf/api deploy --prod --legacy --deploy-all-files "$release_root/apps/api"
pnpm --filter @kf/web deploy --prod --legacy --deploy-all-files "$release_root/apps/web"
pnpm --filter @kf/worker deploy --prod --legacy --deploy-all-files "$release_root/apps/worker"
pnpm --filter @kf/checkpoint deploy --prod --legacy --deploy-all-files "$release_root/apps/checkpoint"
pnpm --filter @kf/operations deploy --prod --legacy --deploy-all-files "$release_root/packages/operations"
pnpm --filter @kf/export deploy --prod --legacy --deploy-all-files "$release_root/packages/export"

cp -a scripts deploy "$release_root/"
install -d "$release_root/docs"
cp -a docs/operating-model docs/backup-and-restore docs/deployment "$release_root/docs/"
cp -a database "$release_root/"
install -d "$release_root/generated"
cp -a generated/sql-registry "$release_root/generated/"

# Package the already-installed, architecture-matched native dbmate binary. Target never
# resolves this tool from a registry or PATH.
dbmate_binary="$(node --input-type=module -e \
  "import { resolveBinary } from './node_modules/dbmate/dist/resolveBinary.js'; \
   process.stdout.write(resolveBinary())")"
install -d "$release_root/tools"
install -m 0755 "$dbmate_binary" "$release_root/tools/dbmate"

# Supply a reviewed native compiler artifact produced from the recorded Liminal commit and its
# exact Cargo.lock. Runtime paths are the target's immutable ELF interpreter/library closure;
# they stay external because the ELF records their absolute paths, but their ordered paths and
# content digests are sealed into the release. Empty or placeholder artifacts are refused.
test -n "${LIMINAL_COMPILER_ARTIFACT:-}" \
  && test -n "${LIMINAL_CARGO_LOCK_ARTIFACT:-}" \
  && test -n "${LIMINAL_RUNTIME_FILE_PATHS:-}" || {
  echo 'Liminal compiler, Cargo.lock and runtime closure must be supplied' >&2
  exit 1
}
IFS=: read -r -a liminal_runtime_files <<< "$LIMINAL_RUNTIME_FILE_PATHS"
scripts/deploy/assemble-liminal-runtime.sh \
  "$release_root" \
  "$LIMINAL_COMPILER_ARTIFACT" \
  "$LIMINAL_CARGO_LOCK_ARTIFACT" \
  "${liminal_runtime_files[@]}"

# Next may write runtime cache data. Unit bind-mounts this exact directory from /var/cache;
# no other path inside immutable release becomes writable.
install -d "$release_root/apps/web/.next/cache"

printf 'git_commit=%s\nnode=%s\npnpm=%s\ndbmate=%s\n' \
  "$(git rev-parse HEAD)" "$(node --version)" "$(pnpm --version)" \
  "$("$release_root/tools/dbmate" --version)" \
  > "$release_root/BUILD-METADATA"
cat "$release_root/vendor/liminal/RUNTIME.env" >> "$release_root/BUILD-METADATA"
(
  cd "$release_root"
  find -P . -mindepth 1 -type d -printf '%P\n' | LC_ALL=C sort > DIRECTORIES
  find -P . -type l -printf '%P\t%l\n' | LC_ALL=C sort > SYMLINKS
  find -P . -type f ! -path ./SHA256SUMS -printf '%P\0' \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum > SHA256SUMS
)
sha256sum "$release_root/SHA256SUMS" \
  > "release/knowledge-fabric-$release_id.manifest.sha256"
tar -C release -czf "release/knowledge-fabric-$release_id.tar.gz" \
  "knowledge-fabric-$release_id"
(
  cd release
  sha256sum "knowledge-fabric-$release_id.tar.gz" \
    > "knowledge-fabric-$release_id.tar.gz.sha256"
)
```

The archive intentionally contains no `.env`, database dump, signing key, certificate or
operator token. Transfer the archive, archive checksum and manifest checksum through the
approved private channel. On target, verify archive checksum before extraction. Run verifier
with release-packaged dbmate, exact reviewed manifest digest/version and expected owner uid:

```sh
sudo -u kf-migrator env \
  KF_DBMATE_BIN=/path/to/extracted-release/tools/dbmate \
  KF_EXPECTED_DBMATE_VERSION=2.35.0 \
  KF_EXPECTED_RELEASE_MANIFEST_SHA256=<reviewed-manifest-digest> \
  KF_EXPECTED_RELEASE_OWNER_UID=0 \
  /path/to/extracted-release/scripts/deploy/migrate-release.sh check \
  /path/to/extracted-release
```

Command rejects changed bytes, extra files/directories/symlinks, changed or escaping links,
special filesystem entries, wrong ownership, group/other-writable paths, unpinned dbmate and
malformed migration pairs.

Copy the six `LIMINAL_*` pin values from `vendor/liminal/RUNTIME.env` into reviewed worker
configuration. Do not source that file as shell code. Before worker starts,
`verify-liminal-runtime.sh` requires configured compiler and lock paths to resolve to packaged
bytes, rehashes those bytes, verifies exact ordered host-library paths against
`RUNTIME-CLOSURE.json`, and streams every library through bounded hashing. Runtime files must
be root-owned, non-writable by group/other, at most 128 MiB each and at most 512 MiB together.
Worker startup then stages and executes that
same pinned compiler under bubblewrap with `--protocol kf-document-v1 --preflight`. It requires
exact canonical response `{"protocol":"kf-document-v1","status":"ready"}\n`. Generic
`/usr/bin/true`, empty locks and successful sandbox setup alone are not compiler evidence.
Assembler/verifier helpers and worker unit discard `NODE_OPTIONS` and `NODE_PATH`; deployment
must not restore preload hooks through a unit drop-in.
Preflight proves byte identity and runtime loadability only; it does not qualify, ratify, enable
or promote the compiler. Those remain separate human-authority records.

Extract as root with `tar --no-same-owner --no-same-permissions`; otherwise archive may retain
workstation uid and release verifier correctly refuses `KF_EXPECTED_RELEASE_OWNER_UID=0`.
Extract into new release directory, never over previous release or `/opt/kf` symlink target.

Keep previous release intact. After file check and rollback rehearsal pass and services are
stopped, switch `/opt/kf` atomically to new release, run privileged migration, then run service
preflight. Do not rebuild or edit under release directory.

Database migrations are separate privileged operation. They run once with `kf-migrator`
credential from exact migration set reviewed for release; API and worker never receive that
credential.
[`../../scripts/deploy/migrate-release.sh`](../../scripts/deploy/migrate-release.sh) has no
mutating default command and `kf-migrate.service` has no install target. Starting application
services never applies schema changes.

## Migration and rollback rehearsal

Before migration, stop API, web and worker; take pre-migration backup, copy it off host, and
restore it into isolated target. Then provision separate disposable PostgreSQL 18 cluster with
no non-system schemas. Its credential must differ from production migrator credential. Run:

```sh
sudo -u kf-migrator env \
  KF_DBMATE_BIN=/path/to/extracted-release/tools/dbmate \
  KF_EXPECTED_DBMATE_VERSION=2.35.0 \
  KF_EXPECTED_RELEASE_MANIFEST_SHA256=<reviewed-manifest-digest> \
  KF_EXPECTED_RELEASE_OWNER_UID=0 \
  KF_MIGRATION_LOCK_FILE=/var/lib/kf-migrator/migration.lock \
  KF_REHEARSAL_DATABASE_URL_FILE=/etc/kf/migrator/rehearsal-database-url \
  KF_REHEARSAL_DISPOSABLE_CLUSTER_CONFIRMATION=dedicated-disposable-cluster \
  KF_REHEARSAL_TARGET_LABEL=<non-secret-target-label> \
  /path/to/extracted-release/scripts/deploy/migrate-release.sh rehearse-rollback \
  /path/to/extracted-release \
  /var/lib/kf-migrator/rollback-rehearsal-<release-id>.receipt
```

Rehearsal refuses reserved/nonempty databases, applies every migration, seeds exact generated
ontology, rolls back every migration, and verifies zero applied rows and zero remaining
non-system schemas. Migrations deliberately retain cluster-global roles; destroy disposable
cluster afterward. Receipt contains digests/version/label, no URL or credential. Receipt is
execution evidence, not approval or commissioning record.

Set exact receipt path and manifest digest in `/etc/kf/migrator.env`; point `/opt/kf` at
verified release; run `systemctl start kf-migrate.service`. Any failure stops deployment.
Runner never attempts automatic production rollback: forward migration plus seed can cross
transaction boundaries, so automatic `down` could turn one known failure into partial rollback.

Application-only rollback is allowed only when reviewed compatibility evidence says previous
release accepts new schema: stop services, verify previous release, switch `/opt/kf` back, then
re-run preflight. For incompatible schema or partial migration, restore pre-migration backup
into new database instance, verify audit/export/readiness there, then change credential file
under approved recovery procedure. Never run `dbmate down` against production database.

## PostgreSQL: consider raising `jit_above_cost`

Not applied by any migration, because it is a host-wide setting and choosing it belongs to
whoever operates the host. Recorded with the measurement so the choice is informed.

The fabric's row-level security nests: a typed table's policy tests `exists (select 1 from
core.object …)`, and `core.object`'s own policies run inside that. The planner's cost estimate
for the nested form comes out around **2.2 million** — an artefact of the subplan structure,
not of the work — which crosses the default `jit_above_cost` of 100,000. PostgreSQL then
compiles ~44 functions for a query that does not need them.

Measured on 36,007 objects, reading one organization's 12,000 controlled documents as
`kf_readonly` (`KF_MEASURE_RLS=1`, `tests/database/rls-read-cost.test.ts`):

| read                                 | median    |
| ------------------------------------ | --------- |
| through the policy                   | 146 ms    |
| the same read, `set local jit = off` | **16 ms** |
| the equivalent hand-written join     | 16 ms     |

So on this workload JIT costs about 8x the query it is compiling, and the effect grows with
policy nesting — it lands hardest on exactly the tables decision 0003 added policies to.

```sh
# In postgresql.conf, after confirming it suits the rest of the workload on this host:
jit_above_cost = 500000     # or: jit = off
```

This is a starting point, not a recommendation to apply blind. A host that also runs large
analytical queries may want JIT for those, and the right threshold depends on what else the
database does. Re-measure with the harness above after changing it.

## Runtime configuration

The API environment contains non-secret routing facts:

```sh
NODE_ENV=production
KF_DEPLOYMENT_PROFILE=dogfood
KF_TLS_TERMINATED_UPSTREAM=1
HOST=127.0.0.1
PORT=4000
OIDC_ISSUER=https://identity.example.internal/realms/knowledge-fabric
OIDC_AUDIENCE=knowledge-fabric-api
OIDC_JWKS_URI=https://identity.example.internal/realms/knowledge-fabric/protocol/openid-connect/certs
```

The issuer is exact: it must equal the token `iss`, including scheme and path. The API audience
must appear in `aud`; a browser-client ID is not a substitute unless the provider deliberately
adds the API audience. The JWKS endpoint has to be reachable by the API without disabling TLS
verification.

Credentials arrive through owner-only files:

- `DATABASE_URL_FILE` for the constrained application role;
- `S3_SECRET_ACCESS_KEY_FILE` plus the non-secret S3 endpoint, region, access-key ID and bucket;
- a different worker database credential if its grants differ;
- a migrator credential readable only by `kf-migrator`, never API/web/worker;
- a 32-byte base64 web session key readable only by `kf-web`;
- `CHECKPOINT_SIGNING_KEY_PATH`, readable only by the signer identity and never by the API.

Do not set `DATABASE_URL`, `S3_SECRET_ACCESS_KEY`, `KF_ALLOW_FIXED_IDENTITY` or any `KF_DEV_*`
value on the host. The API already refuses inline database and S3 secrets in production.

Keycloak configuration must be reviewed as configuration, not clicked into existence and then
remembered. At minimum record the realm export or equivalent reproducible configuration,
client redirect origins, API audience mapper, token lifetime, MFA policy, administrator access
and key-rotation procedure. Link each allowed token `sub` to a person through the recorded
operating procedure; never auto-provision a person from a successful login.

Tracked service units and non-secret environment templates live in
[`../../deploy/systemd/`](../../deploy/systemd/). API and web bind only `127.0.0.1`; command
arguments override environment-file attempts to widen them. Worker and migrator have separate
unprivileged identities. Nginx template in
[`../../deploy/nginx/knowledge-fabric.conf`](../../deploy/nginx/knowledge-fabric.conf) redirects
HTTP, terminates TLS, rejects unknown virtual hosts and proxies only to loopback. Replace example
hostnames with reviewed names and certificate paths; run `nginx -t`; do not generate or enroll
certificates from this repository.

## Host preflight and evidence

Before any shared user is admitted:

1. Verify the release archive and internal checksum manifest.
2. Verify `systemd-analyze verify` and `nginx -t` on installed artifacts. Verify proxy redirects
   HTTP to HTTPS and application ports reject non-loopback connections.
3. Verify a valid bearer token succeeds, a wrong issuer fails, a wrong audience fails, an
   unknown `sub` fails, a revoked identity fails and fixed identity headers are ignored.
4. Verify `/health` reports process liveness, `/ready` performs a database round trip and
   `/readiness` reports separate service and institutional verdicts. Service `degraded`, `failed`
   or `unknown` is a failed service preflight. Any institutional blocker still fails the governed
   operation or commissioning claim it protects even when HTTP status is `200`; never treat service
   availability as institutional approval.
5. Run and record a backup, off-host copy and restore drill using the declared recovery
   objective.
6. Verify checkpoint signing from the signer service and prove the API service account cannot
   read the private key.
7. Verify rollback rehearsal receipt matches exact release; verify migration service succeeded
   once and does not run on reboot or application restart.
8. Verify `verify-liminal-runtime.sh /opt/kf` succeeds under `kf-worker`, then prove a changed
   compiler, lock or runtime-library copy fails before worker start. Preserve failure output;
   never convert it into a qualification receipt.
9. Reboot host and re-run checks. Service that works only in install shell is not
   deployed.

## Commissioning: run it, do not read it

Everything below used to be a prose list of things nobody had done — a checklist a reader can
agree with and move past. It is now a program.

```sh
KF_SYSTEMD_DIR=/etc/systemd/system \
KF_SHIPPED_UNIT_DIR=/opt/kf/deploy/systemd \
KF_PUBLIC_HOSTNAME=fabric.example.org \
KF_TLS_CERTIFICATE=/etc/ssl/kf/fullchain.pem \
KF_TLS_PRIVATE_KEY=/etc/ssl/kf/privkey.pem \
KF_IDENTITY_ISSUER=https://sso.example.org/realms/kf \
KF_IDENTITY_CLIENT_ID=knowledge-fabric \
KF_IDENTITY_POLICY=/etc/kf/realm-policy.json \
KF_IDENTITY_POLICY_SHA256=<digest recorded at review> \
KF_EVIDENCE_DIR=/var/lib/kf/commissioning \
KF_RELEASE_ID=<release this host is running> \
KF_EXPECTED_NODE_VERSION=24.18.1 \
  kf-commissioning            # add --json for an evidence record
```

Exit status is 0 only when every check is **satisfied**. There are three states, and the third
is the point:

| state          | meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `satisfied`    | the check looked at real host state and it was as required                  |
| `unsatisfied`  | the check looked at real host state and it was not                          |
| `unverifiable` | the check could not see what it needs — an absent path, an unsupplied value |

`unverifiable` fails exactly as `unsatisfied` does. It is a separate word only so that "we
looked and it was wrong" is never confused with "we could not look". A verifier that reported a
missing certificate as compliant would be worse than no verifier, because somebody would cite
it.

What each check reads, and the blocker it closes:

| check                      | reads                                                                                                                               | blocker                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `unit_provenance`          | installed units against the ones this release ships, byte for byte; `User=` on the API and checkpoint units; `OnFailure=` on each   | units installed, identities separated, alerting wired               |
| `secret_posture`           | every path a shipped unit names as `EnvironmentFile=` or `*_FILE=`/`*_KEY_PATH=`: exists, regular file, no group or other bits      | checkpoint key isolation from the API                               |
| `tls_termination`          | the certificate for the public hostname — SAN coverage, validity window, renewal margin — and the private key's mode                | site hostname, certificate, TLS termination                         |
| `identity_provider_policy` | issuer is https, client is named, and the reviewed realm policy on disk still digests to what was reviewed                          | reviewed reproducible Keycloak realm/client policy                  |
| `runtime_version`          | the Node version this process runs, against the tested one                                                                          | host uses the exact tested runtime                                  |
| `evidence_receipts`        | release verification, rollback rehearsal and compiler qualification receipts: present, naming this release, ratified, recent enough | rollback receipt, migration result, ratified compiler qualification |

`unit_provenance` and `secret_posture` consider only the unit names this release ships.
Everything else installed on the host is somebody else's contract, and an earlier version that
read the whole of `/etc/systemd/system` reported that `display-manager.service` declares no
`OnFailure=` — true, irrelevant, and enough to fail a correctly commissioned host.

### What it deliberately cannot tell you

Three things stay human evidence, and the verifier reports `unverifiable` rather than guessing:

- **real-provider browser evidence.** `identity_provider_policy` proves the deployment points
  at the reviewed policy; it cannot prove a person can sign in or that the flow behaves.
- **firewall rules and installed nginx validation.** The certificate check proves the name is
  covered; it does not prove what can reach the port.
- **service start, restart and reboot behaviour.** `unit_provenance` proves the right units are
  installed; whether the host survives a reboot is observed, not inferred.

## Known blockers; no readiness claim

Repository supplies application/migrator units, environment templates, TLS proxy template,
release verifier, migration runner, rollback-rehearsal contract, and the commissioning verifier
above. None has been commissioned on a host. Remaining blockers — each now with a check that
reports on it rather than a paragraph describing it:

- no reviewed reproducible Keycloak realm/client policy or real-provider browser evidence;
- no site hostnames, certificates, firewall rules or installed nginx validation;
- no installed user/file ownership evidence, service start/restart/reboot evidence or proof
  host uses exact tested Node/PostgreSQL versions;
- no successful disposable-cluster rollback receipt or host migration result for a release;
- no concrete `kf-alert@.service` integration;
- no reviewed native `kf-document-v1` Liminal artifact, external runtime-closure inventory or
  human-ratified qualification receipt has been supplied by this repository;
- scheduled operation units still share `kf` identity; checkpoint key isolation from API is
  designed by separate service user, but filesystem denial remains host evidence gate.

Until those are implemented and the host evidence exists, this document is a target and a
fail-closed checklist. It must not be cited as proof that the Knowledge Fabric is an
institutionally authoritative service.
