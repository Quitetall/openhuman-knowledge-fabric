#!/usr/bin/env bash
#
# Build one release tree, exactly as `docs/deployment/private-host.md` § "Build once on the
# workstation" specifies.
#
# THIS IS A TRANSCRIPT, NOT A SUBSTITUTE. That document explains WHY each step is what it is —
# why the worktree must be disposable and provably clean, why `--legacy` and
# `--deploy-all-files` are gone, why modes are normalised before sealing, why tar records root.
# Every one of those paragraphs is a defect somebody already hit. Read it before changing
# anything here, and change both together or they drift.
#
# It exists because the build had been run only from a copy in a session scratchpad, and that
# scratchpad was cleared overnight — twice. A procedure whose only executable form lives in
# /tmp is a procedure that will be reconstructed from memory the next time it is needed, which
# is how a release quietly stops matching its own runbook.
#
# usage: scripts/deploy/build-release.sh
#        LIMINAL_COMPILER_ARTIFACT=... LIMINAL_CARGO_LOCK_ARTIFACT=... \
#        LIMINAL_RUNTIME_FILE_PATHS=a:b:c  scripts/deploy/build-release.sh
#
# Builds at the CURRENT HEAD of the repository it is run from. It creates a disposable worktree
# and never deletes anything outside it.

set -euo pipefail

source_root="$(git rev-parse --show-toplevel)"
release_commit="$(git rev-parse HEAD)"
build_parent="$(mktemp -d)"

echo "== disposable worktree at $release_commit =="
git -C "$source_root" worktree add --detach "$build_parent/source" "$release_commit"
cd "$build_parent/source"

# Git's normal dirty check omits ignored dist/, .next/ and dependency trees, so it cannot prove
# the runtime bytes are fresh. This can.
test -z "$(git status --porcelain=v1 --untracked-files=all --ignored)" || {
  echo 'refusing release build from a nonempty disposable worktree' >&2
  exit 1
}

echo "== pnpm install --frozen-lockfile =="
pnpm install --frozen-lockfile

# Runs every check ci.yml defines except the secrets scan, in that file's order, ending with
# `pnpm build` — so the release bytes are built by the same command that gates them.
echo "== pnpm gate =="
pnpm gate

release_id="$(git rev-parse --short=12 HEAD)"
release_root="release/knowledge-fabric-$release_id"
test ! -e "$release_root" || {
  echo "refusing to reuse $release_root" >&2
  exit 1
}
install -d "$release_root/apps" "$release_root/packages"

# Plain --prod. `pnpm-workspace.yaml` sets injectWorkspacePackages, so workspace dependencies
# are copied rather than linked out of the release root.
echo "== deploy package trees =="
pnpm --filter @kf/api deploy --prod "$release_root/apps/api"
pnpm --filter @kf/web deploy --prod "$release_root/apps/web"
pnpm --filter @kf/worker deploy --prod "$release_root/apps/worker"
pnpm --filter @kf/checkpoint deploy --prod "$release_root/apps/checkpoint"
pnpm --filter @kf/operations deploy --prod "$release_root/packages/operations"
pnpm --filter @kf/export deploy --prod "$release_root/packages/export"

cp -a scripts deploy "$release_root/"
install -d "$release_root/docs"
cp -a docs/operating-model docs/backup-and-restore docs/deployment "$release_root/docs/"
cp -a database "$release_root/"
install -d "$release_root/generated"
cp -a generated/sql-registry "$release_root/generated/"

# Package the already-installed, architecture-matched native dbmate binary. The target never
# resolves this tool from a registry or PATH.
dbmate_binary="$(node --input-type=module -e \
  "import { resolveBinary } from './node_modules/dbmate/dist/resolveBinary.js'; \
   process.stdout.write(resolveBinary())")"
install -d "$release_root/tools"
install -m 0755 "$dbmate_binary" "$release_root/tools/dbmate"

# All three LIMINAL_* values, or none. A partial set is refused rather than resolved, because
# guessing which half was meant is how a release seals an artifact nobody reviewed. ADR 0010
# defers the Liminal-backed compiler, so `liminal=none` is the ordinary case.
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

# Next may write runtime cache data. The unit bind-mounts this exact directory from /var/cache;
# no other path inside the immutable release becomes writable.
install -d "$release_root/apps/web/.next/cache"

# `liminal=` is what `liminal_runtime_inventory` reads. BUILD-METADATA is covered by SHA256SUMS,
# so the declaration is sealed with everything else and cannot be edited on the host without
# failing `migrate-release.sh check`.
printf 'git_commit=%s\nnode=%s\npnpm=%s\ndbmate=%s\nliminal=%s\n' \
  "$(git rev-parse HEAD)" "$(node --version)" "$(pnpm --version)" \
  "$("$release_root/tools/dbmate" --version)" "$liminal_declaration" \
  > "$release_root/BUILD-METADATA"
if [ "$liminal_declaration" = sealed ]; then
  cat "$release_root/vendor/liminal/RUNTIME.env" >> "$release_root/BUILD-METADATA"
fi

# Normalise modes BEFORE sealing. The build machine's umask is not part of the release, and on
# 2026-08-26 it turned out to be: the first host install carried group/other-writable files and
# the verifier refused on the first one it reached. SHA256SUMS covers content, not modes, so
# nothing downstream would have noticed — only the verifier, at install time.
echo "== normalise modes before sealing =="
find "$release_root" -type d -exec chmod go-w,go+rx {} +
find "$release_root" -type f -exec chmod go-w {} +

echo "== seal =="
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

# --owner=root --group=root --numeric-owner: the release is root-owned ON THE HOST and
# `migrate-release.sh check` enforces that with KF_EXPECTED_RELEASE_OWNER_UID=0. Without these,
# tar records whoever ran the build and `sudo tar -x` faithfully restores it, so verification
# fails on a release that is otherwise perfect.
tar -C release --owner=root --group=root --numeric-owner \
  -czf "release/knowledge-fabric-$release_id.tar.gz" \
  "knowledge-fabric-$release_id"
(
  cd release
  sha256sum "knowledge-fabric-$release_id.tar.gz" \
    > "knowledge-fabric-$release_id.tar.gz.sha256"
)

echo
echo "=== BUILT ==="
echo "release_id  $release_id"
echo "root        $build_parent/source/$release_root"
cat "$release_root/BUILD-METADATA"
echo "files       $(wc -l < "$release_root/SHA256SUMS")"
echo "manifest    $(cat "release/knowledge-fabric-$release_id.manifest.sha256")"
du -sh "$release_root" "release/knowledge-fabric-$release_id.tar.gz"
echo
echo "The disposable worktree is left in place at $build_parent so the tarball can be copied."
echo "Remove it with: git -C $source_root worktree remove --force $build_parent/source"
