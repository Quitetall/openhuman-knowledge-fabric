#!/usr/bin/env bash
# Fail-closed startup verification for release-packaged Liminal bytes and host runtime closure.

set -Eeuo pipefail
export LC_ALL=C

fail() {
  echo "Liminal runtime refused: $*" >&2
  exit 1
}

[ "$#" -eq 1 ] || {
  echo 'usage: verify-liminal-runtime.sh RELEASE_DIRECTORY' >&2
  exit 64
}

release_argument="$1"
[ -d "$release_argument" ] || fail "release directory does not exist: $release_argument"
release_root="$(readlink -f -- "$release_argument")"
[ -n "$release_root" ] && [ "$release_root" != / ] || fail 'release directory resolved unsafely'

for name in \
  LIMINAL_COMPILER_PATH \
  LIMINAL_CARGO_LOCK_PATH \
  LIMINAL_RUNTIME_FILE_PATHS \
  LIMINAL_EXECUTABLE_SHA256 \
  LIMINAL_CARGO_LOCK_SHA256 \
  LIMINAL_RUNTIME_CLOSURE_SHA256; do
  [ -n "${!name:-}" ] || fail "$name is required"
done
for name in \
  LIMINAL_EXECUTABLE_SHA256 \
  LIMINAL_CARGO_LOCK_SHA256 \
  LIMINAL_RUNTIME_CLOSURE_SHA256; do
  [[ "${!name}" =~ ^[0-9a-f]{64}$ ]] || fail "$name must be one lowercase SHA-256 digest"
done

packaged_compiler="$release_root/vendor/liminal/liminal-document-compiler"
packaged_cargo_lock="$release_root/vendor/liminal/Cargo.lock"
runtime_manifest="$release_root/vendor/liminal/RUNTIME-CLOSURE.json"
[ -f "$packaged_compiler" ] && [ ! -L "$packaged_compiler" ] && [ -x "$packaged_compiler" ] ||
  fail 'release-packaged compiler is absent or not executable'
[ -f "$packaged_cargo_lock" ] && [ ! -L "$packaged_cargo_lock" ] ||
  fail 'release-packaged Cargo.lock is absent'
[ -f "$runtime_manifest" ] && [ ! -L "$runtime_manifest" ] ||
  fail 'release runtime-closure manifest is absent'
[ "$(stat -Lc '%s' -- "$runtime_manifest")" -le 1048576 ] ||
  fail 'release runtime-closure manifest exceeds 1048576 bytes'

configured_compiler="$(readlink -f -- "$LIMINAL_COMPILER_PATH")"
configured_cargo_lock="$(readlink -f -- "$LIMINAL_CARGO_LOCK_PATH")"
case "$configured_compiler" in "$release_root"/*) ;; *) fail 'packaged compiler leaves release' ;; esac
case "$configured_cargo_lock" in
  "$release_root"/*) ;;
  *) fail 'packaged Cargo.lock leaves release' ;;
esac
[ "$configured_compiler" = "$(readlink -f -- "$packaged_compiler")" ] ||
  fail 'LIMINAL_COMPILER_PATH must name release-packaged compiler'
[ "$configured_cargo_lock" = "$(readlink -f -- "$packaged_cargo_lock")" ] ||
  fail 'LIMINAL_CARGO_LOCK_PATH must name release-packaged Cargo.lock'
for configured_file in "$configured_compiler" "$configured_cargo_lock" "$runtime_manifest"; do
  configured_mode="$(stat -Lc '%a' -- "$configured_file")"
  [ $((8#$configured_mode & 8#022)) -eq 0 ] ||
    fail "configured artifact is group/other writable: $configured_file"
done

elf_magic="$(od -An -tx1 -N4 -- "$configured_compiler" | tr -d ' \n')"
[ "$elf_magic" = '7f454c46' ] || fail 'configured compiler is not a native ELF executable'
actual_compiler_digest="$(sha256sum -- "$configured_compiler" | awk '{print $1}')"
actual_cargo_lock_digest="$(sha256sum -- "$configured_cargo_lock" | awk '{print $1}')"
[ "$actual_compiler_digest" = "$LIMINAL_EXECUTABLE_SHA256" ] ||
  fail 'configured compiler digest mismatch'
[ "$actual_cargo_lock_digest" = "$LIMINAL_CARGO_LOCK_SHA256" ] ||
  fail 'configured Cargo.lock digest mismatch'

runtime_result="$({
  /usr/bin/env -i LC_ALL=C PATH=/usr/bin:/bin \
    /usr/bin/node --input-type=module - \
    "$runtime_manifest" \
    "$LIMINAL_RUNTIME_FILE_PATHS" \
    "$LIMINAL_RUNTIME_CLOSURE_SHA256" <<'NODE'
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { posix as path } from 'node:path';

const [manifestPath, configuredPathList, expectedDigest] = process.argv.slice(2);
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  fail('runtime closure manifest is not valid JSON');
}
if (
  manifest === null ||
  typeof manifest !== 'object' ||
  Array.isArray(manifest) ||
  JSON.stringify(Object.keys(manifest).sort()) !==
    JSON.stringify(['entries', 'format', 'runtimeClosureDigest']) ||
  manifest.format !== 'kf-liminal-runtime-closure-v1' ||
  !Array.isArray(manifest.entries) ||
  !/^[0-9a-f]{64}$/.test(manifest.runtimeClosureDigest)
) {
  fail('runtime closure manifest has unsupported shape');
}
const configuredPaths = [...new Set(configuredPathList.split(':').filter(Boolean))];
if (configuredPaths.length === 0) fail('runtime closure path list is empty');
if (
  configuredPaths.some(
    (entry) =>
      !entry.startsWith('/') ||
      !/^\/[A-Za-z0-9._/+@=-]+$/.test(entry) ||
      path.normalize(entry) !== entry ||
      !['/lib/', '/lib64/', '/usr/lib/', '/usr/lib64/'].some((root) =>
        entry.startsWith(root),
      ),
  )
) {
  fail('runtime closure contains a non-normalized or unapproved path');
}
if (
  manifest.entries.length !== configuredPaths.length ||
  manifest.entries.some(
    (entry, index) =>
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['contentDigest', 'path']) ||
      entry.path !== configuredPaths[index] ||
      !/^[0-9a-f]{64}$/.test(entry.contentDigest),
  )
) {
  fail('configured runtime closure differs from release manifest');
}
const maxRuntimeFileBytes = 128 * 1024 * 1024;
const maxRuntimeClosureBytes = 512 * 1024 * 1024;
let totalBytes = 0;
const actualEntries = [];
for (const path of configuredPaths) {
  let metadata;
  try {
    metadata = statSync(path);
  } catch {
    fail(`runtime closure file cannot be read: ${path}`);
  }
  if (!metadata.isFile()) fail(`runtime closure path is not a regular file: ${path}`);
  if (metadata.uid !== 0) fail(`runtime closure file is not owned by root: ${path}`);
  if ((metadata.mode & 0o022) !== 0) fail(`runtime closure file is group/other writable: ${path}`);
  if (!Number.isSafeInteger(metadata.size) || metadata.size > maxRuntimeFileBytes) {
    fail(`runtime closure file exceeds ${String(maxRuntimeFileBytes)} bytes: ${path}`);
  }
  totalBytes += metadata.size;
  if (!Number.isSafeInteger(totalBytes) || totalBytes > maxRuntimeClosureBytes) {
    fail(`runtime closure exceeds ${String(maxRuntimeClosureBytes)} bytes`);
  }
  const hash = createHash('sha256');
  let bytesRead = 0;
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
      bytesRead += chunk.byteLength;
      if (bytesRead > maxRuntimeFileBytes) {
        fail(`runtime closure file grew beyond ${String(maxRuntimeFileBytes)} bytes: ${path}`);
      }
      hash.update(chunk);
    }
  } catch {
    fail(`runtime closure file cannot be hashed: ${path}`);
  }
  if (bytesRead !== metadata.size) fail(`runtime closure file changed size while hashing: ${path}`);
  actualEntries.push({ contentDigest: hash.digest('hex'), path });
}
if (
  actualEntries.some(
    (entry, index) => entry.contentDigest !== manifest.entries[index].contentDigest,
  )
) {
  fail('runtime closure file digest differs from release manifest');
}
const actualDigest = createHash('sha256')
  .update(JSON.stringify(actualEntries))
  .digest('hex');
if (actualDigest !== manifest.runtimeClosureDigest || actualDigest !== expectedDigest) {
  fail('runtime closure digest mismatch');
}
process.stdout.write(actualDigest);
NODE
} 2>&1)" || fail "$runtime_result"
[[ "$runtime_result" =~ ^[0-9a-f]{64}$ ]] ||
  fail 'runtime closure verifier returned malformed output'

echo "Liminal runtime verified: $runtime_result"
