#!/usr/bin/env bash
# Apply only exact, reviewed migration bytes. Rollback rehearsal runs only against an explicitly
# disposable empty database; production rollback is restore-based and never automatic here.

set -Eeuo pipefail
export LC_ALL=C

usage() {
  cat >&2 <<'EOF'
usage:
  migrate-release.sh check RELEASE_DIRECTORY
  migrate-release.sh rehearse-rollback RELEASE_DIRECTORY RECEIPT_PATH
  migrate-release.sh apply RELEASE_DIRECTORY

No command is the safe default. `apply` requires an exact release manifest digest, pinned
dbmate version, successful matching rehearsal receipt, owner-only database secret file, and
KF_MIGRATION_APPLY_CONFIRMATION=apply-reviewed-release.
EOF
}

fail() {
  echo "migration refused: $*" >&2
  exit 1
}

command_name="${1:-}"
case "$command_name" in
  check|apply)
    [ "$#" -eq 2 ] || { usage; exit 64; }
    ;;
  rehearse-rollback)
    [ "$#" -eq 3 ] || { usage; exit 64; }
    ;;
  *)
    usage
    exit 64
    ;;
esac

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=scripts/lib/secret.sh
. "$script_directory/../lib/secret.sh"

work_directory=""
cleanup_migration_work() {
  if [ -n "$work_directory" ] && [ -d "$work_directory" ]; then
    rm -rf -- "$work_directory"
  fi
}
kf_at_exit cleanup_migration_work

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

release_argument="$2"
[ -d "$release_argument" ] || fail "release directory does not exist: $release_argument"
release_root="$(readlink -f -- "$release_argument")"
[ -n "$release_root" ] && [ "$release_root" != / ] || fail 'release directory resolved unsafely'

manifest="$release_root/SHA256SUMS"
directory_inventory="$release_root/DIRECTORIES"
symlink_inventory="$release_root/SYMLINKS"
migration_directory="$release_root/database/migrations"
ontology_seed="$release_root/generated/sql-registry/001-ontology-seed.sql"

verify_release_tree() {
  require_command sha256sum
  require_command find
  require_command sort
  require_command cmp
  require_command stat
  require_command readlink

  [ -f "$manifest" ] || fail 'release has no SHA256SUMS'
  [ -f "$directory_inventory" ] || fail 'release has no DIRECTORIES inventory'
  [ -f "$symlink_inventory" ] || fail 'release has no SYMLINKS inventory'
  [ -d "$migration_directory" ] || fail 'release has no database/migrations directory'
  [ -f "$ontology_seed" ] || fail 'release has no generated ontology seed'

  expected_manifest_digest="${KF_EXPECTED_RELEASE_MANIFEST_SHA256:-}"
  [[ "$expected_manifest_digest" =~ ^[0-9a-f]{64}$ ]] ||
    fail 'KF_EXPECTED_RELEASE_MANIFEST_SHA256 must be one lowercase SHA-256 digest'
  actual_manifest_digest="$(sha256sum "$manifest" | awk '{print $1}')"
  [ "$actual_manifest_digest" = "$expected_manifest_digest" ] ||
    fail "release manifest checksum differs: expected $expected_manifest_digest, got $actual_manifest_digest"

  expected_owner_uid="${KF_EXPECTED_RELEASE_OWNER_UID:-}"
  [[ "$expected_owner_uid" =~ ^[0-9]+$ ]] ||
    fail 'KF_EXPECTED_RELEASE_OWNER_UID must be a numeric uid'
  wrong_owner="$(find -P "$release_root" ! -uid "$expected_owner_uid" -print -quit)"
  [ -z "$wrong_owner" ] || fail "release path has unexpected owner: $wrong_owner"
  writable_path="$(find -P "$release_root" ! -type l -perm /022 -print -quit)"
  [ -z "$writable_path" ] || fail "release path is group/other writable: $writable_path"
  unsupported_path="$(
    find -P "$release_root" -mindepth 1 ! -type f ! -type d ! -type l -print -quit
  )"
  [ -z "$unsupported_path" ] ||
    fail "release contains unsupported filesystem entry: $unsupported_path"

  work_directory="$(mktemp -d)"
  manifest_files="$work_directory/manifest-files"
  actual_files="$work_directory/actual-files"
  actual_directories="$work_directory/actual-directories"
  actual_symlinks="$work_directory/actual-symlinks"

  : > "$manifest_files"
  while IFS= read -r line || [ -n "$line" ]; do
    [ "${#line}" -ge 67 ] || fail 'SHA256SUMS has a malformed line'
    digest="${line:0:64}"
    separator="${line:64:2}"
    path="${line:66}"
    [[ "$digest" =~ ^[0-9a-f]{64}$ ]] && [ "$separator" = '  ' ] ||
      fail 'SHA256SUMS must use lowercase SHA-256 text-mode records'
    case "$path" in
      ''|/*|.|./*|..|../*|*/.|*/./*|*/..|*/../*) fail "unsafe path in SHA256SUMS: $path" ;;
    esac
    printf '%s\n' "$path" >> "$manifest_files"
  done < "$manifest"
  [ -s "$manifest_files" ] || fail 'SHA256SUMS is empty'
  duplicate="$(sort "$manifest_files" | uniq -d | head -n 1)"
  [ -z "$duplicate" ] || fail "duplicate path in SHA256SUMS: $duplicate"
  sort -o "$manifest_files" "$manifest_files"

  (
    cd "$release_root"
    find -P . -type f ! -path ./SHA256SUMS -printf '%P\n' | sort > "$actual_files"
  )
  if ! cmp -s "$manifest_files" "$actual_files"; then
    diff -u "$manifest_files" "$actual_files" >&2 || true
    fail 'release file inventory differs from SHA256SUMS'
  fi

  (
    cd "$release_root"
    find -P . -mindepth 1 -type d -printf '%P\n' | sort > "$actual_directories"
    find -P . -type l -printf '%P\t%l\n' | sort > "$actual_symlinks"
  )
  cmp -s "$directory_inventory" "$actual_directories" ||
    fail 'release directory inventory differs from DIRECTORIES'
  cmp -s "$symlink_inventory" "$actual_symlinks" ||
    fail 'release symlink inventory differs from SYMLINKS'

  while IFS=$'\t' read -r link target || [ -n "$link$target" ]; do
    [ -n "$link" ] && [ -n "$target" ] || fail 'SYMLINKS has a malformed line'
    case "$link" in /*|..|../*|*/..|*/../*) fail "unsafe link path in SYMLINKS: $link" ;; esac
    resolved_target="$(readlink -f -- "$release_root/$link")"
    case "$resolved_target" in
      "$release_root"/*) ;;
      *) fail "symlink leaves or is broken outside release: $link -> $target" ;;
    esac
  done < "$symlink_inventory"

  (
    cd "$release_root"
    sha256sum --strict --check --quiet SHA256SUMS
  ) || fail 'release file checksum verification failed'

  migration_count=0
  while IFS= read -r migration; do
    migration_count=$((migration_count + 1))
    [ "$(grep -c '^-- migrate:up$' "$migration" || true)" -eq 1 ] ||
      fail "migration lacks one exact up marker: $migration"
    [ "$(grep -c '^-- migrate:down$' "$migration" || true)" -eq 1 ] ||
      fail "migration lacks one exact down marker: $migration"
    up_line="$(grep -n '^-- migrate:up$' "$migration" | cut -d: -f1)"
    down_line="$(grep -n '^-- migrate:down$' "$migration" | cut -d: -f1)"
    [ "$up_line" -lt "$down_line" ] || fail "migration down marker precedes up: $migration"
  done < <(find -P "$migration_directory" -maxdepth 1 -type f -name '*.sql' | sort)
  [ "$migration_count" -gt 0 ] || fail 'release migration set is empty'

  dbmate_bin="${KF_DBMATE_BIN:-}"
  expected_dbmate_version="${KF_EXPECTED_DBMATE_VERSION:-}"
  [ -n "$dbmate_bin" ] && [ -x "$dbmate_bin" ] || fail 'KF_DBMATE_BIN is not executable'
  packaged_dbmate="$(readlink -f -- "$release_root/tools/dbmate")"
  configured_dbmate="$(readlink -f -- "$dbmate_bin")"
  [ -n "$packaged_dbmate" ] && [ "$configured_dbmate" = "$packaged_dbmate" ] ||
    fail 'KF_DBMATE_BIN must be release-packaged tools/dbmate'
  [[ "$expected_dbmate_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    fail 'KF_EXPECTED_DBMATE_VERSION must be an exact semantic version'
  dbmate_version_output="$("$dbmate_bin" --version 2>&1)"
  actual_dbmate_version="$(
    printf '%s\n' "$dbmate_version_output" |
      awk '$1 == "dbmate" && $2 == "version" && NF == 3 { print $3 }'
  )"
  [ "$actual_dbmate_version" = "$expected_dbmate_version" ] ||
    fail "dbmate version differs: expected $expected_dbmate_version, got $dbmate_version_output"

  migration_set_digest="$(
    grep -E '  (database/migrations/[^/]+\.sql|generated/sql-registry/001-ontology-seed\.sql)$' \
      "$manifest" | sha256sum | awk '{print $1}'
  )"
}

acquire_lock() {
  require_command flock
  lock_file="${KF_MIGRATION_LOCK_FILE:-}"
  [ -n "$lock_file" ] && [[ "$lock_file" = /* ]] ||
    fail 'KF_MIGRATION_LOCK_FILE must be an absolute path'
  [ -d "$(dirname -- "$lock_file")" ] || fail 'migration lock parent directory does not exist'
  exec 9>"$lock_file"
  flock -n 9 || fail 'another migration or rehearsal command holds the lock'
}

resolve_database_secret() {
  [ -z "${DATABASE_URL:-}" ] || fail 'inline DATABASE_URL is refused; use DATABASE_URL_FILE'
  [ -n "${DATABASE_URL_FILE:-}" ] || fail 'DATABASE_URL_FILE is required'
  kf_resolve_database_url || fail 'database credential could not be resolved'
}

run_dbmate() {
  "$dbmate_bin" --migrations-dir "$migration_directory" --no-dump-schema "$@"
}

receipt_value() {
  local key="$1"
  local receipt="$2"
  local count
  count="$(grep -c "^${key}=" "$receipt" || true)"
  [ "$count" -eq 1 ] || fail "rollback rehearsal receipt has invalid $key"
  grep "^${key}=" "$receipt" | cut -d= -f2-
}

verify_receipt() {
  receipt="${KF_ROLLBACK_REHEARSAL_RECEIPT:-}"
  [ -n "$receipt" ] && [[ "$receipt" = /* ]] ||
    fail 'KF_ROLLBACK_REHEARSAL_RECEIPT must be an absolute path'
  [ -f "$receipt" ] && [ ! -L "$receipt" ] ||
    fail 'KF_ROLLBACK_REHEARSAL_RECEIPT must name a regular non-symlink file'
  receipt_mode="$(stat -c '%a' "$receipt")"
  [ $((8#$receipt_mode & 8#022)) -eq 0 ] ||
    fail 'rollback rehearsal receipt must not be group/other writable'
  [ "$(receipt_value format "$receipt")" = 'kf-migration-rollback-rehearsal-v1' ] ||
    fail 'rollback rehearsal receipt format is unsupported'
  [ "$(receipt_value manifest_sha256 "$receipt")" = "$actual_manifest_digest" ] ||
    fail 'rollback rehearsal receipt belongs to another release manifest'
  [ "$(receipt_value migration_set_sha256 "$receipt")" = "$migration_set_digest" ] ||
    fail 'rollback rehearsal receipt belongs to another migration set'
  [ "$(receipt_value dbmate_version "$receipt")" = "$expected_dbmate_version" ] ||
    fail 'rollback rehearsal receipt used another dbmate version'
}

verify_release_tree

case "$command_name" in
  check)
    echo "release verified: $release_root"
    ;;

  rehearse-rollback)
    [ "${KF_REHEARSAL_DISPOSABLE_CLUSTER_CONFIRMATION:-}" = 'dedicated-disposable-cluster' ] ||
      fail 'set KF_REHEARSAL_DISPOSABLE_CLUSTER_CONFIRMATION=dedicated-disposable-cluster'
    rehearsal_secret="${KF_REHEARSAL_DATABASE_URL_FILE:-}"
    [ -n "$rehearsal_secret" ] || fail 'KF_REHEARSAL_DATABASE_URL_FILE is required'
    if [ -n "${DATABASE_URL_FILE:-}" ] &&
      [ "$(readlink -f -- "$DATABASE_URL_FILE")" = "$(readlink -f -- "$rehearsal_secret")" ]; then
      fail 'rehearsal database credential must not be production DATABASE_URL_FILE'
    fi
    unset DATABASE_URL
    DATABASE_URL_FILE="$rehearsal_secret"
    export DATABASE_URL_FILE
    resolve_database_secret
    acquire_lock
    psql_bin="${KF_PSQL_BIN:-/usr/bin/psql}"
    [ -x "$psql_bin" ] || fail 'KF_PSQL_BIN is not executable'

    scratch_state="$(
      "$psql_bin" "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
        "select current_database() || '|' || case when current_database() in ('postgres','template0','template1') or exists (select 1 from pg_namespace where nspname not in ('pg_catalog','information_schema','public') and nspname !~ '^pg_toast') or exists (select 1 from pg_namespace n join pg_class c on c.relnamespace = n.oid where n.nspname = 'public' and c.relname <> 'schema_migrations') or to_regclass('public.schema_migrations') is not null then 'not-empty' else 'empty' end"
    )"
    case "$scratch_state" in
      *'|empty') ;;
      *) fail "rollback rehearsal target is reserved or not empty: $scratch_state" ;;
    esac

    run_dbmate up
    "$psql_bin" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q -f "$ontology_seed"
    for ((index = 0; index < migration_count; index += 1)); do
      run_dbmate down
    done
    remaining="$(
      "$psql_bin" "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
        "select (select count(*) from public.schema_migrations)::text || '|' || (select count(*) from pg_namespace where nspname not in ('pg_catalog','information_schema','public') and nspname !~ '^pg_toast')::text || '|' || (select count(*) from pg_namespace n join pg_class c on c.relnamespace = n.oid where n.nspname = 'public' and c.relname <> 'schema_migrations')::text"
    )"
    [ "$remaining" = '0|0|0' ] ||
      fail "rollback rehearsal left migration state, schemas or public relations: $remaining"

    receipt_path="$3"
    [[ "$receipt_path" = /* ]] || fail 'rehearsal RECEIPT_PATH must be absolute'
    [ ! -e "$receipt_path" ] || fail 'rehearsal receipt already exists; refusing overwrite'
    [ -d "$(dirname -- "$receipt_path")" ] || fail 'rehearsal receipt parent does not exist'
    target_label="${KF_REHEARSAL_TARGET_LABEL:-}"
    [[ "$target_label" =~ ^[A-Za-z0-9._-]{1,80}$ ]] ||
      fail 'KF_REHEARSAL_TARGET_LABEL must be 1..80 safe non-secret characters'
    receipt_temp="$(mktemp "$(dirname -- "$receipt_path")/.kf-rehearsal.XXXXXX")"
    chmod 0600 "$receipt_temp"
    cat > "$receipt_temp" <<EOF
format=kf-migration-rollback-rehearsal-v1
manifest_sha256=$actual_manifest_digest
migration_set_sha256=$migration_set_digest
dbmate_version=$expected_dbmate_version
rehearsed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
scratch_label=$target_label
EOF
    # Hard-link creation is atomic and refuses an existing destination. `mv -n` reports
    # success when it skips, which would let a race retain somebody else's receipt.
    ln -- "$receipt_temp" "$receipt_path" || fail 'rehearsal receipt appeared concurrently'
    rm -f -- "$receipt_temp"
    echo "rollback rehearsal passed; receipt written: $receipt_path"
    ;;

  apply)
    [ "${KF_MIGRATION_APPLY_CONFIRMATION:-}" = 'apply-reviewed-release' ] ||
      fail 'set KF_MIGRATION_APPLY_CONFIRMATION=apply-reviewed-release'
    verify_receipt
    resolve_database_secret
    acquire_lock
    psql_bin="${KF_PSQL_BIN:-/usr/bin/psql}"
    [ -x "$psql_bin" ] || fail 'KF_PSQL_BIN is not executable'
    run_dbmate up
    "$psql_bin" "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -q -f "$ontology_seed"
    run_dbmate status
    echo "reviewed migration set applied: $migration_set_digest"
    ;;
esac
