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

Install **pandoc**, on `PATH`, for the process that serves document import.
`packages/documents/src/internal/pandoc-parser.ts` runs `pandoc --from=<format> --to=json` as a
child process, so a host without it answers every document import with HTTP 500 and logs
`spawn pandoc ENOENT` — the API deliberately does not tell the caller more than a request id.

**This requirement was undocumented until 2026-08-18**, when CI ran the suite on a machine that
was not the workstation and three import tests failed opaquely. It had always been satisfied here
by pandoc being installed years ago for something else, which is the same way the PostgreSQL 18
client and `/usr/bin/node` were satisfied: by accident of one machine's history.

**The version is an open question, not a settled requirement.** The parser reads
`pandoc-api-version` from the AST and records it as the atoms' `parserVersion`, so the version is
carried in the provenance rather than assumed — but nothing requires a particular one, and two
hosts running different pandocs can produce different atoms for the same source. For a system
whose parity criterion is byte-identical compilation, that is worth a decision rather than a
default. Recorded here so the decision is visible; not taken here.

Install **python3**, on `PATH`, for the LamQuant compatibility oracle.
`packages/documents/src/lamquant-compat.ts` runs the source gates through
`options.pythonExecutable ?? 'python3'`, and nothing in the codebase supplies that option — the
fallback IS the production path. A host without python3 fails every compatibility run with
`spawn python3 ENOENT`.

**This requirement was undocumented until 2026-08-20**, and it is the sixth of its kind. It was
found by moving CI onto a deliberately near-empty `ubuntu:24.04` container, and it is worth
noting that **GitHub's hosted runner would never have found it**: `ubuntu-latest` ships python3,
so CI was green on a machine that satisfied the requirement by accident in exactly the way this
workstation did. Only an image that installs nothing exposed it.

No version is pinned. The gates are invoked as a plain interpreter and this repository does not
constrain which python3; if that ever needs to be a real requirement it belongs here, next to
the same open question recorded above for pandoc.

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

`pnpm gate` runs every check `ci.yml` defines except the `secrets` scan, in that file's order, ending with
`pnpm build` — so the release bytes below are built by the same command that gates them. It
replaces the five checks previously listed here, which were five of the seven: the two ontology
gates were missing, so a release could be cut from a tree whose committed `generated/` did not
match its `ontology/`. `tests/deployment/gate-parity.test.ts` keeps the command and `ci.yml` in
agreement, and pins the CI jobs that run no pnpm command so a second CI-only gate cannot appear
unnoticed.

This paragraph used to say `pnpm gate` was the only gate an operator could rely on, because no
CI job had ever executed here — 38 runs, 38 failures at job-start on Actions billing. CI passed
for the first time on 2026-08-18 (run `32146924053`, commit `93e5b6c4`).

Read the platform requirements above with that in mind. Qualifying the first machine that was not
the workstation found FIVE of them unsatisfied, and the suite had been green throughout on a
workstation that happened to satisfy all five by accident of its own history. That is the specific
risk this document exists to remove, and it went undetected for the life of the repository because
there was never a second machine to detect it.

After those gates pass, assemble runnable package directories from those already-built bytes.
`--legacy` is required by repository's current non-injected pnpm workspace layout. It is a
packaging mode, not permission to change the lockfile.

**These six lines carried `--deploy-all-files` until 2026-08-25, and on the pinned pnpm that
flag does not exist.** `packageManager` pins `pnpm@11.21.0`; `pnpm deploy --help` lists
`--legacy` and `--prod` and no such option, so the documented command exits immediately with
`Unknown option: 'deploy-all-files'`. Every release built by following this section verbatim
would have stopped here, and none ever was — this was found by running it for the first time.

Removing it needed care, because the sentence it replaced named a real hazard: root
`.gitignore` excludes `dist/` and `.next/`, and a deploy that honours the packlist ships a
package with no runtime in it. So the question is not whether the flag is gone but whether its
BEHAVIOUR is, and that was measured rather than assumed on pnpm 11.21.0:

| deploy of               | `dist/` | `.next/`                                   |
| ----------------------- | ------- | ------------------------------------------ |
| `@kf/operations`, plain | present | n/a                                        |
| `@kf/web`, plain        | n/a     | present — `BUILD_ID`, `server/`, 365 files |

and `--config.deploy-all-files=true` produced a tree byte-identical to plain. The flag became
the default. Its removal is therefore safe here and the old warning is now false, but the
hazard it described is not imaginary: if a future pnpm reverts this, a release will ship
without runtime and nothing in the tarball will look wrong. `tests/deployment/deploy-flags.test.ts`
holds these commands to the flags the pinned pnpm actually accepts.

```sh
release_id="$(git rev-parse --short=12 HEAD)"
release_root="release/knowledge-fabric-$release_id"
test ! -e "$release_root" || {
  echo "refusing to reuse $release_root" >&2
  exit 1
}
install -d "$release_root/apps" "$release_root/packages"

pnpm --filter @kf/api deploy --prod --legacy "$release_root/apps/api"
pnpm --filter @kf/web deploy --prod --legacy "$release_root/apps/web"
pnpm --filter @kf/worker deploy --prod --legacy "$release_root/apps/worker"
pnpm --filter @kf/checkpoint deploy --prod --legacy "$release_root/apps/checkpoint"
pnpm --filter @kf/operations deploy --prod --legacy "$release_root/packages/operations"
pnpm --filter @kf/export deploy --prod --legacy "$release_root/packages/export"

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

# A release MAY carry a reviewed Liminal compiler, and must say which. ADR 0010 defers the
# Liminal-backed compiler: v1.0 ships the native one, so `liminal=none` is the ordinary case
# and this block was previously an unconditional `exit 1`.
#
# All three values, or none of the three. A partial set is refused rather than resolved,
# because guessing which half was meant is how a release seals an artifact nobody reviewed.
# When supplied: runtime paths are the target's immutable ELF interpreter/library closure, and
# stay external because the ELF records their absolute paths, but their ordered paths and
# content digests are sealed into the release. Empty or placeholder artifacts are refused.
liminal_supplied=0
for value in "${LIMINAL_COMPILER_ARTIFACT:-}" "${LIMINAL_CARGO_LOCK_ARTIFACT:-}" \
             "${LIMINAL_RUNTIME_FILE_PATHS:-}"; do
  test -n "$value" && liminal_supplied=$((liminal_supplied + 1))
done
case "$liminal_supplied" in
  3) liminal_declaration=sealed ;;
  0) liminal_declaration=none ;;
  *) echo 'supply all of LIMINAL_COMPILER_ARTIFACT, LIMINAL_CARGO_LOCK_ARTIFACT and' \
          'LIMINAL_RUNTIME_FILE_PATHS, or none of them' >&2
     exit 1 ;;
esac

if [ "$liminal_declaration" = sealed ]; then
  IFS=: read -r -a liminal_runtime_files <<< "$LIMINAL_RUNTIME_FILE_PATHS"
  scripts/deploy/assemble-liminal-runtime.sh \
    "$release_root" \
    "$LIMINAL_COMPILER_ARTIFACT" \
    "$LIMINAL_CARGO_LOCK_ARTIFACT" \
    "${liminal_runtime_files[@]}"
fi

# Next may write runtime cache data. Unit bind-mounts this exact directory from /var/cache;
# no other path inside immutable release becomes writable.
install -d "$release_root/apps/web/.next/cache"

# `liminal=` is what `liminal_runtime_inventory` reads. BUILD-METADATA is covered by
# SHA256SUMS, so the declaration is sealed with everything else and cannot be edited on the
# host without failing `migrate-release.sh check`.
printf 'git_commit=%s\nnode=%s\npnpm=%s\ndbmate=%s\nliminal=%s\n' \
  "$(git rev-parse HEAD)" "$(node --version)" "$(pnpm --version)" \
  "$("$release_root/tools/dbmate" --version)" "$liminal_declaration" \
  > "$release_root/BUILD-METADATA"
if [ "$liminal_declaration" = sealed ]; then
  cat "$release_root/vendor/liminal/RUNTIME.env" >> "$release_root/BUILD-METADATA"
fi
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

## PostgreSQL JIT: do not tune it host-wide

**Recommendation: leave the defaults alone.** An earlier revision of this section suggested
`jit_above_cost = 500000`. That was wrong twice over and is corrected here rather than
quietly dropped.

The fabric's row-level security nests: a typed table's policy tests `exists (select 1 from
core.object …)`, and `core.object`'s own policies run inside that. On an unbounded scan the
planner's estimate for the nested form comes out around **2.2 million** — an artefact of the
subplan structure, not of the work — which crosses the default `jit_above_cost` of 100,000,
and PostgreSQL compiles ~44 functions for a query that does not need them.

That much is real. What was missing was whether it happens to any query the application
actually runs. Measured on 36,007 objects as `kf_readonly` (`KF_MEASURE_RLS=1`,
`tests/database/rls-read-cost.test.ts`), with the query shapes the API issues:

| query shape            | JIT         | with JIT | JIT off | planner estimate |
| ---------------------- | ----------- | -------- | ------- | ---------------- |
| point read by id       | idle        | 0.5 ms   | 0.3 ms  | 70               |
| bounded list (50 rows) | idle        | 13.4 ms  | 15.4 ms | 6,174            |
| envelope join, bounded | idle        | 1.0 ms   | 1.0 ms  | 6,274            |
| unbounded `count(*)`   | **engaged** | 146.7 ms | 16.2 ms | 2,222,440        |

**JIT never engages on a bounded query.** Every application shape estimates three to four
orders of magnitude below the threshold. Tuning JIT would change nothing about API latency,
and a setting that changes nothing is worse than none: it reads as a mitigation.

The second error was the value. Against a 2.2 million estimate, `500000` is still below the
threshold being crossed:

| setting on the unbounded scan | median                                           |
| ----------------------------- | ------------------------------------------------ |
| default                       | 151.5 ms                                         |
| `jit_above_cost = 500000`     | 140.1 ms ← the value previously recommended here |
| `jit_above_cost = 5000000`    | 16.2 ms                                          |
| inline + optimize raised      | 25.0 ms                                          |
| `jit = off`                   | 17.0 ms                                          |

The previously suggested value buys 7%. Raising `jit_inline_above_cost` and
`jit_optimize_above_cost` instead recovers most of the win while keeping basic JIT, because
those two phases were 90 ms of the 137 ms.

**If it ever does matter**, it will be for the paths that scan without a bound — readiness
counts, search index rebuilds, exports, an auditor session on `kf_readonly` — none of which is
latency-critical. Set it on those roles rather than on the host:

```sh
alter role kf_readonly set jit_above_cost = 5000000;   -- only if a scan-heavy path needs it
```

One caveat that cuts the other way, worth knowing before treating 9x as a standing figure: the
JIT cost is roughly FIXED (~130 ms of compilation) while the scan cost grows with the data. At
ten times this row count the scan itself dominates and the relative penalty shrinks; far enough
out, JIT starts paying for itself. The 9x is a property of this data size, not a constant.
Re-measure with the harness above before acting on it.

And the general caution that still applies whatever is decided: a host that also runs large
analytical queries may want JIT for those, so the right threshold depends on everything else
the database does, not only on the fabric. Re-measure after any change.

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

The Node version comes out of the release's own sealed metadata rather than a literal, because
a literal goes stale against the release it is meant to describe. It is a function so that an
absent, empty or duplicated line fails HERE, loudly, instead of passing an empty string to
`kf-commissioning` — which would report "no tested Node version was supplied" about a value
the operator believes they supplied.

```sh
kf_release_node_version() {
  local version
  version="$(sed -n 's/^node=v//p' "$KF_RELEASE_DIR/BUILD-METADATA")"
  test "$(printf '%s' "$version" | grep -c .)" -eq 1 || {
    echo "BUILD-METADATA in $KF_RELEASE_DIR has no single node= line" >&2
    return 1
  }
  printf '%s' "$version"
}

KF_SYSTEMD_DIR=/etc/systemd/system \
KF_SHIPPED_UNIT_DIR=/opt/kf/deploy/systemd \
KF_PUBLIC_HOSTNAME=fabric.example.org \
KF_TLS_CERTIFICATE=/etc/ssl/kf/fullchain.pem \
KF_TLS_PRIVATE_KEY=/etc/ssl/kf/privkey.pem \
KF_IDENTITY_ISSUER=https://sso.example.org/realms/kf \
KF_IDENTITY_CLIENT_ID=knowledge-fabric \
KF_IDENTITY_POLICY=/etc/kf/realm-policy.json \
KF_IDENTITY_POLICY_SHA256=<digest recorded at review> \
KF_REVERSE_PROXY_CONFIG=/etc/nginx/sites-enabled/kf \
KF_RELEASE_DIR=/opt/kf/release \
KF_EVIDENCE_DIR=/var/lib/kf/commissioning \
KF_RELEASE_ID=<release this host is running> \
KF_EXPECTED_NODE_VERSION="$(kf_release_node_version)" \
  kf-commissioning            # add --json for an evidence record
```

**`KF_REVERSE_PROXY_CONFIG` and `KF_RELEASE_DIR` were missing from this block until
2026-08-24, and that was not cosmetic.** `reverse_proxy_posture` and
`liminal_runtime_inventory` are two of the eight checks, both read one of those paths, and a
check with no input reports `unverifiable` — which fails. So an operator following this
document exactly could not reach 8/8 satisfied, and the two failures would name variables
this document had never mentioned. It was found by running `kf-commissioning` on a
workstation, which had also never been done.

Three more have defaults and are therefore easy to miss, and two of them decide verdicts:

| variable                      | default                             | what it changes                                         |
| ----------------------------- | ----------------------------------- | ------------------------------------------------------- |
| `KF_CERTIFICATE_RENEWAL_DAYS` | `21`                                | how close to expiry a certificate may be and still pass |
| `KF_ROLLBACK_REHEARSAL_DAYS`  | `180`                               | how old a rollback rehearsal receipt may be             |
| `KF_ALERT_DISPATCH`           | `/opt/kf/scripts/alert-dispatch.sh` | the script `--send-test-alert` runs                     |

`kf-commissioning --help` prints all of this from the same table the program reads, so it
cannot describe a different program than the one on the host. Prefer it to this section when
the two disagree, and then fix this section.

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

| check                       | reads                                                                                                                                                                 | blocker                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `unit_provenance`           | installed units against the ones this release ships, byte for byte; `User=` on the API and checkpoint units; `OnFailure=` on each                                     | units installed, identities separated, alerting wired               |
| `secret_posture`            | every path a shipped unit names as `EnvironmentFile=` or `*_FILE=`/`*_KEY_PATH=`: exists, regular file, no group or other bits                                        | checkpoint key isolation from the API                               |
| `tls_termination`           | the certificate for the public hostname — SAN coverage, validity window, renewal margin — and the private key's mode                                                  | site hostname, certificate, TLS termination                         |
| `identity_provider_policy`  | issuer is https, client is named, and the reviewed realm policy on disk still digests to what was reviewed                                                            | reviewed reproducible Keycloak realm/client policy                  |
| `runtime_version`           | the Node version this process runs, against the tested one                                                                                                            | host uses the exact tested runtime                                  |
| `reverse_proxy_posture`     | the installed nginx configuration: refuses a cleartext server that proxies, a non-loopback upstream, TLS 1.0/1.1, and a proxying block that drops the original scheme | installed nginx validation                                          |
| `liminal_runtime_inventory` | the compiler and its runtime closure on this host, via the release's own `verify-liminal-runtime.sh`                                                                  | reviewed compiler artifact and runtime-closure inventory            |
| `evidence_receipts`         | release verification, rollback rehearsal and compiler qualification receipts: present, naming this release, ratified, recent enough                                   | rollback receipt, migration result, ratified compiler qualification |

`unit_provenance` and `secret_posture` consider only the unit names this release ships.
Everything else installed on the host is somebody else's contract, and an earlier version that
read the whole of `/etc/systemd/system` reported that `display-manager.service` declares no
`OnFailure=` — true, irrelevant, and enough to fail a correctly commissioned host.

### What it deliberately cannot tell you

Three things stay human evidence, and the verifier reports `unverifiable` rather than guessing:

- **real-provider browser evidence.** `identity_provider_policy` proves the deployment points
  at the reviewed policy; it cannot prove a person can sign in or that the flow behaves.
- **firewall rules.** The certificate check proves the name is covered and
  `reverse_proxy_posture` reads the installed nginx configuration; neither proves what can reach
  the port. This bullet said "firewall rules and installed nginx validation" until 2026-08-24,
  which stopped being true when `reverse_proxy_posture` shipped.
- **service start, restart and reboot behaviour.** `unit_provenance` proves the right units are
  installed; whether the host survives a reboot is observed, not inferred.

## Known blockers; no readiness claim

Repository supplies application/migrator units, environment templates, TLS proxy template,
release verifier, migration runner, rollback-rehearsal contract, and the commissioning verifier
above. None has been commissioned on a host.

Each blocker below names the `kf-commissioning` check that reports on it, or says plainly that
it has none. An earlier revision claimed "each now with a check that reports on it rather than
a paragraph describing it", and that was not true of four of them — a blanket claim over a list
where the coverage is genuinely uneven. `tests/deployment/commissioning-blockers.test.ts` keeps
these markers and the check registry in agreement, so neither can drift and an unchecked blocker
cannot quietly acquire the appearance of coverage.

- no reviewed reproducible Keycloak realm/client policy — `identity_provider_policy`. Real-provider
  browser evidence, named in the same sentence, has **no check**: the verifier reads the
  configured issuer, client and policy digest, and cannot tell whether a person ever completed a
  login against the real realm.
- no site hostnames or certificates — `tls_termination`, which reads the certificate the host
  presents, checks it covers the served name and is currently valid, and checks the private key
  is closed. Installed nginx validation is now `reverse_proxy_posture`, which reads the
  configuration as installed and refuses a cleartext server that proxies, an upstream that is
  not loopback, TLS 1.0/1.1, and a proxying block that does not forward the original scheme.
  It does not follow `include` directives and cannot interrogate the running nginx, so point it
  at the file that defines the server blocks. Firewall rules have **no check** and remain
  inspection by hand.
- no installed user/file ownership evidence, service start/restart/reboot evidence —
  `unit_provenance`; and no proof host uses exact tested Node/PostgreSQL versions —
  `runtime_version`.
- no successful disposable-cluster rollback receipt or host migration result for a release —
  `evidence_receipts`, which requires a receipt matched to the running release id.
- no person has yet received an alert — **no check**, and none is possible from here.
  `kf-alert@.service` ships and `tests/deployment/alert-dispatch.test.ts` proves it delivers
  over real TLS and fails loudly when it cannot, but a webhook URL that is wrong, revoked or
  pointed at an abandoned channel passes every one of those and reaches nobody.
  `unit_provenance` verifies each unit declares `OnFailure=`, which is a weaker claim again.

  Run `kf-commissioning --send-test-alert` during commissioning. It sends one real alert and
  then tells you what it has and has not established: the endpoint accepted a message, and
  nothing more. Ask the person who is meant to receive alerts whether one arrived, naming
  `kf-commissioning-test.service`, and record their answer in the evidence.
  `kf-alert-heartbeat.timer` then keeps the path proven daily, by its absence.

- no reviewed native `kf-document-v1` Liminal artifact or external runtime-closure inventory —
  `liminal_runtime_inventory`, which runs the release's own
  `scripts/deploy/verify-liminal-runtime.sh` against the installed tree rather than
  reimplementing its digesting. It needs the six `LIMINAL_*` values `kf-worker.service`
  supplies, and reports `unverifiable` rather than passing when they are absent. The
  human-ratified qualification receipt in the same sentence is covered by `evidence_receipts`.
- key isolation is now expressed in the units — each private key is owned mode `0600` by the
  one identity that uses it — but **filesystem denial remains host evidence**. The units say
  who may read a key; only the installed host proves nobody else can. Reported by
  `secret_posture`, which inspects the mode of every secret a unit names.

  This line previously read "scheduled operation units still share `kf` identity". They did:
  five units ran as one account, so both signing keys were readable by the backup, offsite,
  readiness and restore-drill jobs, including the one whose purpose is copying bytes to another
  machine. Fixed 2026-08-17 by giving each its own identity. `kf-commissioning` now refuses a
  host where units sharing an identity do not need the same secrets — the property that failure
  violated, and one that comparing only the API against the checkpoint signer could not catch.

Until those are implemented and the host evidence exists, this document is a target and a
fail-closed checklist. It must not be cited as proof that the Knowledge Fabric is an
institutionally authoritative service.
