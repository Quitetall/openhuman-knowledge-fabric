#!/usr/bin/env bash
# Assemble reviewed Liminal compiler bytes and an explicit host-runtime closure contract.

set -Eeuo pipefail
export LC_ALL=C

usage() {
  cat >&2 <<'EOF'
usage: assemble-liminal-runtime.sh RELEASE_DIRECTORY COMPILER CARGO_LOCK RUNTIME_FILE...

Copies exact compiler and Cargo.lock bytes into RELEASE_DIRECTORY/vendor/liminal. Runtime
libraries remain explicit immutable host artifacts because the ELF interpreter names their
absolute paths; their ordered paths and content digests are sealed into RUNTIME-CLOSURE.json.
EOF
}

fail() {
  echo "Liminal assembly refused: $*" >&2
  exit 1
}

[ "$#" -ge 4 ] || { usage; exit 64; }

release_argument="$1"
compiler_argument="$2"
cargo_lock_argument="$3"
shift 3

[ -d "$release_argument" ] || fail "release directory does not exist: $release_argument"
release_root="$(readlink -f -- "$release_argument")"
[ -n "$release_root" ] && [ "$release_root" != / ] || fail 'release directory resolved unsafely'

compiler_source="$(readlink -f -- "$compiler_argument")"
cargo_lock_source="$(readlink -f -- "$cargo_lock_argument")"
[ -f "$compiler_source" ] && [ -x "$compiler_source" ] ||
  fail 'compiler must resolve to a regular executable file'
[ -f "$cargo_lock_source" ] || fail 'Cargo.lock must resolve to a regular file'

elf_magic="$(od -An -tx1 -N4 -- "$compiler_source" | tr -d ' \n')"
[ "$elf_magic" = '7f454c46' ] || fail 'compiler must be a native ELF executable'

vendor_parent="$release_root/vendor"
[ ! -L "$vendor_parent" ] || fail 'release vendor parent must not be a symbolic link'
if [ -e "$vendor_parent" ]; then
  [ -d "$vendor_parent" ] || fail 'release vendor parent must be a directory'
else
  install -d -m 0755 -- "$vendor_parent"
fi
vendor_root="$vendor_parent/liminal"
[ ! -e "$vendor_root" ] || fail "destination already exists: $vendor_root"
work_directory="$(mktemp -d)"
assembly_complete=0
cleanup_liminal_assembly() {
  rm -rf -- "$work_directory"
  if [ "$assembly_complete" -eq 0 ] && [ -d "$vendor_root" ]; then
    rm -rf -- "$vendor_root"
  fi
}
trap cleanup_liminal_assembly EXIT

install -d -m 0755 -- "$vendor_root"
install -m 0755 -- "$compiler_source" "$vendor_root/liminal-document-compiler"
install -m 0644 -- "$cargo_lock_source" "$vendor_root/Cargo.lock"

runtime_records="$work_directory/runtime-records"
: > "$runtime_records"
declare -A seen_runtime_paths=()
runtime_paths=()
max_runtime_file_bytes=134217728
max_runtime_closure_bytes=536870912
runtime_total_bytes=0
for runtime_path in "$@"; do
  [ -n "$runtime_path" ] && [[ "$runtime_path" = /* ]] ||
    fail 'each runtime file path must be absolute'
  [ "$(realpath -ms -- "$runtime_path")" = "$runtime_path" ] ||
    fail "runtime file path is not normalized: $runtime_path"
  case "$runtime_path" in
    /lib/*|/lib64/*|/usr/lib/*|/usr/lib64/*) ;;
    *) fail "runtime file is outside approved system library roots: $runtime_path" ;;
  esac
  [[ "$runtime_path" =~ ^/[A-Za-z0-9._/+@=-]+$ ]] ||
    fail "runtime file path contains unsupported characters: $runtime_path"
  [ -f "$runtime_path" ] || fail "runtime file is not a regular file: $runtime_path"
  [ "$(stat -Lc '%u' -- "$runtime_path")" -eq 0 ] ||
    fail "runtime file must be owned by root: $runtime_path"
  runtime_mode="$(stat -Lc '%a' -- "$runtime_path")"
  [ $((8#$runtime_mode & 8#022)) -eq 0 ] ||
    fail "runtime file is group/other writable: $runtime_path"
  if [ -n "${seen_runtime_paths[$runtime_path]:-}" ]; then
    continue
  fi
  runtime_size="$(stat -Lc '%s' -- "$runtime_path")"
  [[ "$runtime_size" =~ ^[0-9]+$ ]] || fail "runtime file has invalid size: $runtime_path"
  [ "$runtime_size" -le "$max_runtime_file_bytes" ] ||
    fail "runtime file exceeds $max_runtime_file_bytes bytes: $runtime_path"
  runtime_total_bytes=$((runtime_total_bytes + runtime_size))
  [ "$runtime_total_bytes" -le "$max_runtime_closure_bytes" ] ||
    fail "runtime closure exceeds $max_runtime_closure_bytes bytes"
  seen_runtime_paths[$runtime_path]=1
  runtime_paths+=("$runtime_path")
  printf '%s\t%s\n' "$(sha256sum -- "$runtime_path" | awk '{print $1}')" "$runtime_path" \
    >> "$runtime_records"
done
[ "${#runtime_paths[@]}" -gt 0 ] || fail 'runtime closure must contain at least one file'

runtime_manifest="$vendor_root/RUNTIME-CLOSURE.json"
node_diagnostics="$work_directory/node-diagnostics"
runtime_closure_digest="$(
  /usr/bin/env -i LC_ALL=C PATH=/usr/bin:/bin \
    /usr/bin/node --input-type=module - "$runtime_records" "$runtime_manifest" \
    2>"$node_diagnostics" <<'NODE'
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const records = readFileSync(process.argv[2], 'utf8')
  .trimEnd()
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const separator = line.indexOf('\t');
    return { contentDigest: line.slice(0, separator), path: line.slice(separator + 1) };
  });
const canonicalEntries = JSON.stringify(records);
const runtimeClosureDigest = createHash('sha256').update(canonicalEntries).digest('hex');
const manifest = {
  entries: records,
  format: 'kf-liminal-runtime-closure-v1',
  runtimeClosureDigest,
};
writeFileSync(process.argv[3], `${JSON.stringify(manifest)}\n`, { mode: 0o644 });
process.stdout.write(runtimeClosureDigest);
NODE
)" || fail "could not seal runtime closure: $(tr '\n' ' ' < "$node_diagnostics")"
[ ! -s "$node_diagnostics" ] ||
  fail "runtime closure helper emitted diagnostics: $(tr '\n' ' ' < "$node_diagnostics")"
[[ "$runtime_closure_digest" =~ ^[0-9a-f]{64}$ ]] ||
  fail 'runtime closure helper returned a malformed digest'

compiler_digest="$(sha256sum -- "$vendor_root/liminal-document-compiler" | awk '{print $1}')"
cargo_lock_digest="$(sha256sum -- "$vendor_root/Cargo.lock" | awk '{print $1}')"
runtime_path_list="$(IFS=:; printf '%s' "${runtime_paths[*]}")"

cat > "$vendor_root/RUNTIME.env" <<EOF
LIMINAL_COMPILER_PATH=/opt/kf/vendor/liminal/liminal-document-compiler
LIMINAL_CARGO_LOCK_PATH=/opt/kf/vendor/liminal/Cargo.lock
LIMINAL_RUNTIME_FILE_PATHS=$runtime_path_list
LIMINAL_EXECUTABLE_SHA256=$compiler_digest
LIMINAL_CARGO_LOCK_SHA256=$cargo_lock_digest
LIMINAL_RUNTIME_CLOSURE_SHA256=$runtime_closure_digest
EOF
chmod 0644 "$runtime_manifest" "$vendor_root/RUNTIME.env"
assembly_complete=1

echo "Liminal runtime assembled: $vendor_root"
