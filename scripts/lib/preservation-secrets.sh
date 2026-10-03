# Preservation-only caller adapter. Source secret.sh first. Contents are parsed
# by the Ed25519 export signer and GnuPG, not interpreted by the custody guard.
kf_validate_preservation_key() {
  local path="$1" purpose="$2" maximum size
  case "$purpose" in
    preservation-signing-key) maximum=4096 ;;
    backup-decryption-key) maximum=65536 ;;
    *) echo 'preservation credential purpose refused' >&2; return 1 ;;
  esac
  if [ "${KF_SECRET_CUSTODY:-}" = systemd ] && [ "$(basename -- "$path")" != "$purpose" ]; then
    echo 'preservation credential purpose mismatch' >&2
    return 1
  fi
  [ -f "$path" ] && [ ! -L "$path" ] && [ "$(stat -c '%h' "$path")" = 1 ] || {
    echo 'preservation credential input refused' >&2; return 1;
  }
  size="$(stat -c '%s' "$path")" || return 1
  [ "$size" -ge 1 ] && [ "$size" -le "$maximum" ] || {
    echo 'preservation credential size refused' >&2; return 1;
  }
  kf_validate_secret_file "$path"
}

kf_prepare_preservation_signing_key() {
  local source="${PRESERVATION_SIGNING_KEY_PATH:-}"
  kf_validate_preservation_key "$source" preservation-signing-key || return 1
  if [ "${KF_SECRET_CUSTODY:-}" = systemd ]; then
    kf_validate_private_tmpfs || return 1
    [ -z "${KF_PRESERVATION_STAGED_KEY:-}" ] || {
      echo 'preservation signing credential already prepared' >&2; return 1;
    }
    # The export CLI retains its owner-only file contract. Do not relax it to
    # admit arbitrary group-readable files or copy this credential onto disk.
    # Called in the parent shell, never command substitution: the cleanup hook
    # and new path must survive in the actual backup process.
    KF_PRESERVATION_STAGED_KEY="$(mktemp "$TMPDIR/kf-preservation-key.XXXXXX")" || return 1
    kf_at_exit 'rm -f -- "$KF_PRESERVATION_STAGED_KEY"'
    cat -- "$source" > "$KF_PRESERVATION_STAGED_KEY" || return 1
    chmod 400 "$KF_PRESERVATION_STAGED_KEY" || return 1
    PRESERVATION_SIGNING_KEY_PATH="$KF_PRESERVATION_STAGED_KEY"
  fi
}

kf_validate_backup_decryption_key() {
  kf_validate_preservation_key "$1" backup-decryption-key
}

kf_validate_drill_workspace() {
  [ "${KF_SECRET_CUSTODY:-}" = systemd ] || return 0
  kf_validate_private_tmpfs || return 1
  [ "${KF_DRILL_WORK_ROOT:-}" = "$TMPDIR" ] || {
    echo 'systemd drill work must use its private tmpfs TMPDIR' >&2; return 1;
  }
}

# Internal working copies are owned by this process, never by its caller. Use
# one fixed cleanup function, not path interpolation into the shared EXIT trap.
KF_PRESERVATION_CHILD_FILES=()
KF_PRESERVATION_CHILD_OWNER_PID="$BASHPID"
_kf_cleanup_preservation_children() {
  [ "$KF_PRESERVATION_CHILD_OWNER_PID" = "$BASHPID" ] || return 0
  if [ "${#KF_PRESERVATION_CHILD_FILES[@]}" -gt 0 ]; then
    rm -f -- "${KF_PRESERVATION_CHILD_FILES[@]}"
  fi
}

_kf_bounded_child_file() {
  local path="$1" size
  [ -f "$path" ] && [ ! -L "$path" ] && [ "$(stat -c '%h' "$path")" = 1 ] || {
    echo 'preservation child credential input refused' >&2; return 1;
  }
  size="$(stat -c '%s' "$path")" || return 1
  [ "$size" -ge 1 ] && [ "$size" -le 8192 ] || {
    echo 'preservation child credential size refused' >&2; return 1;
  }
}

_kf_validate_restore_target() {
  local path="$1" parent
  kf_validate_private_tmpfs || return 1
  [[ "$path" == "$TMPDIR/"* ]] && [ "$(basename -- "$path")" = target-url ] &&
    [ "$(readlink -e -- "$path")" = "$path" ] || {
      echo 'restore target must be its private runtime target-url file' >&2; return 1;
    }
  _kf_bounded_child_file "$path" || return 1
  case "$(stat -c '%u:%a:%h' "$path")" in
    "$EUID:400:1"|"$EUID:600:1") ;;
    *) echo 'restore target file custody refused' >&2; return 1 ;;
  esac
  [ "$(stat -f -c '%t' "$path")" = 1021994 ] || {
    echo 'restore target must remain on tmpfs' >&2; return 1;
  }
  parent="$(dirname -- "$path")"
  while [ "$parent" != "$TMPDIR" ]; do
    [ -d "$parent" ] && [ ! -L "$parent" ] &&
      [ "$(stat -c '%u:%a' "$parent")" = "$EUID:700" ] || {
        echo 'restore target directory custody refused' >&2; return 1;
      }
    parent="$(dirname -- "$parent")"
  done
}

_kf_prepare_preservation_child_file() {
  local source="$1" purpose="$2"
  case "$purpose" in database-url|s3-secret-access-key) ;; *) return 1 ;; esac
  KF_PRESERVATION_CHILD_INPUT="$source"
  KF_PRESERVATION_CHILD_OWNED=false
  _kf_bounded_child_file "$source" || return 1
  if [ "${KF_SECRET_CUSTODY:-}" = systemd ]; then
    kf_validate_private_tmpfs || return 1
    if [ "$(dirname -- "$source")" != "${CREDENTIALS_DIRECTORY:-}" ]; then
      [ "$purpose" = database-url ] || {
        echo 'object reader requires its named PID 1 credential' >&2; return 1;
      }
      _kf_validate_restore_target "$source" || return 1
      return 0
    fi
    [ "$(basename -- "$source")" = "$purpose" ] || {
      echo 'preservation child credential purpose mismatch' >&2; return 1;
    }
    kf_validate_secret_file "$source" || return 1
    if [ "$KF_PRESERVATION_CHILD_OWNER_PID" != "$BASHPID" ]; then
      KF_PRESERVATION_CHILD_FILES=()
      KF_PRESERVATION_CHILD_OWNER_PID="$BASHPID"
    fi
    KF_PRESERVATION_CHILD_INPUT="$(mktemp "$TMPDIR/kf-preservation-child.XXXXXX")" || return 1
    KF_PRESERVATION_CHILD_FILES+=("$KF_PRESERVATION_CHILD_INPUT")
    kf_at_exit _kf_cleanup_preservation_children
    KF_PRESERVATION_CHILD_OWNED=true
    cat -- "$source" > "$KF_PRESERVATION_CHILD_INPUT" || return 1
    chmod 400 "$KF_PRESERVATION_CHILD_INPUT" || return 1
  else
    kf_validate_secret_file "$source" || return 1
  fi
}

kf_preservation_database_child() {
  local source="$1" child_source owned status
  shift
  [ "$#" -gt 0 ] || return 1
  if [ -z "$source" ]; then
    # Standalone callers keep their existing inline/sanitized URL + pgpass mode.
    # An explicit systemd deployment never falls back to this path.
    [ -z "${KF_SECRET_CUSTODY:-}" ] || {
      echo 'preservation database child requires a file' >&2; return 1;
    }
    env -u DATABASE_URL_FILE "$@"
    return $?
  fi
  _kf_prepare_preservation_child_file "$source" database-url || return 1
  child_source="$KF_PRESERVATION_CHILD_INPUT"
  owned="$KF_PRESERVATION_CHILD_OWNED"
  if env -u DATABASE_URL -u PGPASSFILE -u KF_PGPASS_OWNED DATABASE_URL_FILE="$child_source" "$@"; then
    status=0
  else
    status=$?
  fi
  if [ "$owned" = true ]; then rm -f -- "$child_source" || return 1; fi
  return "$status"
}

kf_preservation_object_child() {
  local source="$1" child_source owned status
  shift
  [ "$#" -gt 0 ] || return 1
  _kf_prepare_preservation_child_file "$source" s3-secret-access-key || return 1
  child_source="$KF_PRESERVATION_CHILD_INPUT"
  owned="$KF_PRESERVATION_CHILD_OWNED"
  if env -u S3_SECRET_ACCESS_KEY -u DATABASE_URL -u DATABASE_URL_FILE -u PGPASSFILE -u KF_PGPASS_OWNED \
    S3_SECRET_ACCESS_KEY_FILE="$child_source" "$@"; then
    status=0
  else
    status=$?
  fi
  if [ "$owned" = true ]; then rm -f -- "$child_source" || return 1; fi
  return "$status"
}

kf_read_restore_target_file() {
  if [ "${KF_SECRET_CUSTODY:-}" = systemd ]; then
    _kf_validate_restore_target "$1" || return 1
    sed -z -e 's/[[:space:]]*$//' "$1"
  else
    _kf_bounded_child_file "$1" || return 1
    kf_read_secret_file "$1" TARGET_DATABASE_URL_FILE
  fi
}

kf_read_restore_ledger_file() {
  if [ "${KF_SECRET_CUSTODY:-}" = systemd ] && [ "$(basename -- "$1")" != database-url ]; then
    echo 'restore ledger requires its named database credential' >&2; return 1
  fi
  _kf_bounded_child_file "$1" || return 1
  kf_read_secret_file "$1" LEDGER_DATABASE_URL_FILE
}
