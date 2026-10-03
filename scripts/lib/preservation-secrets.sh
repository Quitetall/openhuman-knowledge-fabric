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
