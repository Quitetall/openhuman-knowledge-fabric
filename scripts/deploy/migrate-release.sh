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
    # `readlink -m`, NOT `-f`. This check refused an escaping symlink SILENTLY until
    # 2026-08-26, and the reason is one letter.
    #
    # `-f` requires every component but the last to exist. An escaping link resolves through
    # directories that are absent on the host, so `readlink -f` exits non-zero — and under
    # `set -e` an assignment from a failed command substitution ends the script right here,
    # one line before the `case` that was written to explain the problem. The operator got
    # exit 1 and an empty log for precisely the fault this loop exists to catch. Measured on
    # the first real host install: `.pnpm/node_modules/@kf/api -> ../../../../../../../../apps/api`
    # ended the run with no output at all.
    #
    # `-m` canonicalises without requiring existence, so the two distinct faults can be told
    # apart and both can be named.
    resolved_target="$(readlink -m -- "$release_root/$link")"
    case "$resolved_target" in
      "$release_root"/*) ;;
      *) fail "symlink leaves release: $link -> $target (resolves to $resolved_target)" ;;
    esac
    [ -e "$resolved_target" ] ||
      fail "symlink is broken: $link -> $target (nothing at $resolved_target)"
  done < "$symlink_inventory"

  (
    cd "$release_root"
    sha256sum --strict --check --quiet SHA256SUMS
  ) || fail 'release file checksum verification failed'

  # THE FORWARD-ONLY FLOOR.
  #
  # `rehearse-rollback` used to roll back every migration and require the database to end
  # completely empty. That could never succeed, and the first rehearsal ever run proved it:
  #
  #   Error: pq: cannot drop column organization_id of table core.action
  #          because other objects depend on it (2BP01)
  #
  # `20260816000500_typed_table_row_security_stage_two.sql` creates 91 policies over 28 tables
  # and its down section is a comment saying so — "Forward-only. Reverting would return 28
  # tables ... to unrestricted reads by any role that can connect." That is a deliberate
  # decision, not an oversight, and it collides with an equally deliberate one: that a release
  # must be provably reversible. Both cannot hold, and a check that cannot pass is worth less
  # than one that states something true.
  #
  # So a migration may DECLARE itself irreversible with `-- kf:forward-only <reason>` in its
  # down section, and rollback runs down to the highest such migration rather than to zero.
  # The receipt then attests what is actually promised: reversible to a named floor.
  #
  # FAIL-CLOSED, and this is the half that matters. A down section with no SQL and no
  # declaration is a mistake — somebody wrote `-- migrate:down` and stopped — and it is
  # indistinguishable at run time from the deliberate case until a rollback needs it. That is
  # now refused outright. Declaring forward-only AND writing SQL is likewise refused: it means
  # one of the two is a lie, and there is no safe way to guess which.
  migration_count=0
  forward_only_floor=''
  forward_only_index=0
  forward_only_version=''
  while IFS= read -r migration; do
    migration_count=$((migration_count + 1))
    [ "$(grep -c '^-- migrate:up$' "$migration" || true)" -eq 1 ] ||
      fail "migration lacks one exact up marker: $migration"
    [ "$(grep -c '^-- migrate:down$' "$migration" || true)" -eq 1 ] ||
      fail "migration lacks one exact down marker: $migration"
    up_line="$(grep -n '^-- migrate:up$' "$migration" | cut -d: -f1)"
    down_line="$(grep -n '^-- migrate:down$' "$migration" | cut -d: -f1)"
    [ "$up_line" -lt "$down_line" ] || fail "migration down marker precedes up: $migration"

    down_body="$(tail -n "+$((down_line + 1))" "$migration")"
    # A statement is a non-comment, non-blank line. Comments cannot alter a schema, so this
    # distinguishes "reverts nothing" from "reverts something" without parsing SQL.
    down_statements="$(printf '%s\n' "$down_body" | grep -cE '^[[:space:]]*[^-[:space:]]' || true)"
    # The reason is not decoration. This declaration is the only way out of the fail-closed
    # check below, so it has to cost something to write, and what it costs is stating why. A
    # bare `-- kf:forward-only` with nothing after it is not a declaration.
    declares_forward_only="$(printf '%s\n' "$down_body" | grep -c '^-- kf:forward-only [^[:space:]]' || true)"

    if [ "$declares_forward_only" -gt 0 ] && [ "$down_statements" -gt 0 ]; then
      fail "migration declares kf:forward-only and still has down statements: $migration"
    fi
    if [ "$declares_forward_only" -eq 0 ] && [ "$down_statements" -eq 0 ]; then
      fail "migration down section is empty and does not declare '-- kf:forward-only <reason>': $migration"
    fi
    if [ "$declares_forward_only" -gt 0 ]; then
      forward_only_floor="$(basename -- "$migration")"
      forward_only_index="$migration_count"
      # dbmate's version is the leading digits of the filename. Captured here so the rehearsal
      # can name the floor it expects rather than infer it from a count.
      forward_only_version="${forward_only_floor%%_*}"
      [[ "$forward_only_version" =~ ^[0-9]{14}$ ]] ||
        fail "forward-only migration has no 14-digit version prefix: $migration"
    fi
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
  receipt_format="$(receipt_value format "$receipt")"
  # v1 is refused by name rather than through the generic message below. A v1 receipt asserts
  # the database returned to empty; this migration set cannot do that, so a v1 receipt is
  # either from before the floor existed or from a different set entirely. Either way it must
  # not authorise an apply, and the operator needs to be told which of the two it is.
  [ "$receipt_format" != 'kf-migration-rollback-rehearsal-v1' ] ||
    fail 'rollback rehearsal receipt is v1, which claims full reversibility; re-run the rehearsal to produce a v2 receipt naming the forward-only floor'
  [ "$receipt_format" = 'kf-migration-rollback-rehearsal-v2' ] ||
    fail "rollback rehearsal receipt format is unsupported: $receipt_format"
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

    # Down to the floor, not to zero. With no forward-only migration the floor is 0 and this
    # is exactly the old behaviour.
    reversible_count=$((migration_count - forward_only_index))
    for ((index = 0; index < reversible_count; index += 1)); do
      run_dbmate down
    done

    remaining="$(
      "$psql_bin" "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c \
        "select (select count(*) from public.schema_migrations)::text || '|' || (select count(*) from pg_namespace where nspname not in ('pg_catalog','information_schema','public') and nspname !~ '^pg_toast')::text || '|' || (select count(*) from pg_namespace n join pg_class c on c.relnamespace = n.oid where n.nspname = 'public' and c.relname <> 'schema_migrations')::text || '|' || coalesce((select max(version) from public.schema_migrations), 'none')"
    )"
    applied_after="${remaining%%|*}"
    highest_after="${remaining##*|}"
    if [ "$forward_only_index" -eq 0 ]; then
      # Nothing declared itself irreversible, so the whole set must revert and leave nothing.
      [ "$remaining" = '0|0|0|none' ] ||
        fail "rollback rehearsal left migration state, schemas or public relations: $remaining"
    else
      # Exactly the floor set must remain — not "at most", not "roughly". One row too few
      # means a down ran that should not have; one too many means a down silently failed.
      [ "$applied_after" = "$forward_only_index" ] ||
        fail "rollback rehearsal expected $forward_only_index migration(s) at the forward-only floor $forward_only_floor, found $applied_after (full state: $remaining)"
      # And they must be the RIGHT ones. The count above is arithmetic on a number this script
      # computed itself, so it agrees with a miscount; naming the version that must sit on top
      # is checked against what the database actually holds.
      [ "$highest_after" = "$forward_only_version" ] ||
        fail "rollback rehearsal stopped at migration $highest_after, expected the forward-only floor $forward_only_version ($forward_only_floor)"
    fi

    receipt_path="$3"
    [[ "$receipt_path" = /* ]] || fail 'rehearsal RECEIPT_PATH must be absolute'
    [ ! -e "$receipt_path" ] || fail 'rehearsal receipt already exists; refusing overwrite'
    [ -d "$(dirname -- "$receipt_path")" ] || fail 'rehearsal receipt parent does not exist'
    target_label="${KF_REHEARSAL_TARGET_LABEL:-}"
    [[ "$target_label" =~ ^[A-Za-z0-9._-]{1,80}$ ]] ||
      fail 'KF_REHEARSAL_TARGET_LABEL must be 1..80 safe non-secret characters'
    receipt_temp="$(mktemp "$(dirname -- "$receipt_path")/.kf-rehearsal.XXXXXX")"
    chmod 0600 "$receipt_temp"
    # v2 because the claim changed shape. A v1 receipt asserted the database returned to
    # empty; a v2 receipt says how far back it went and what stopped it. Reading a v2 as a v1
    # would be reading "reversible to a floor" as "reversible", which is the overclaim this
    # whole change exists to remove — so the format string moves rather than the fields being
    # added quietly.
    cat > "$receipt_temp" <<EOF
format=kf-migration-rollback-rehearsal-v2
manifest_sha256=$actual_manifest_digest
migration_set_sha256=$migration_set_digest
dbmate_version=$expected_dbmate_version
rehearsed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
scratch_label=$target_label
migrations_total=$migration_count
migrations_reverted=$reversible_count
forward_only_floor=${forward_only_floor:-none}
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
