# Resolve DATABASE_URL from a file, the same way the TypeScript entry points do.
#
# Sourced, not executed. Every script that needs a connection string sources this first, so
# that a systemd unit can set DATABASE_URL_FILE and never put a credential in the environment
# — where it would be readable from /proc/<pid>/environ by anything running as the same user,
# inherited by every child process, and printed by most crash reporters.
#
# The permission rule matches `loadSecret()` in packages/operations: group or other bits on a
# secret file mean it is already disclosed to another account on this host, so it is refused
# rather than warned about.

kf_read_secret_file() {
  _path="$1"
  _label="$2"
  if [ ! -r "$_path" ]; then
    echo "$_label points at $_path, which cannot be read" >&2
    return 1
  fi
  # %a is the octal mode. 077 is group+other; anything set there fails.
  _mode="$(stat -c '%a' "$_path")"
  if [ $(( 8#$_mode & 8#077 )) -ne 0 ]; then
    echo "$_path is mode $_mode — a secret readable beyond its owner is already disclosed" >&2
    echo "to anything running as another user on this host. chmod 600 it." >&2
    return 1
  fi
  # TRAILING whitespace only. Every editor and every `echo` adds a newline, and a credential
  # that differs from the intended one by one byte fails in a way nobody diagnoses quickly —
  # but a libpq keyword/value string ("host=... user=...") contains spaces that are part of
  # the value, so stripping all whitespace would corrupt it.
  #
  # `sed -z` makes the whole file one record, so `$` anchors at end-of-file rather than
  # end-of-line. GNU sed; these scripts are for the Linux deployment described in
  # deploy/systemd/README.md.
  sed -z -e 's/[[:space:]]*$//' "$_path"
}

kf_resolve_database_url() {
  if [ -n "${DATABASE_URL_FILE:-}" ]; then
    DATABASE_URL="$(kf_read_secret_file "$DATABASE_URL_FILE" DATABASE_URL_FILE)" || return 1
    export DATABASE_URL
  fi
  if [ -z "${DATABASE_URL:-}" ]; then
    echo "neither DATABASE_URL_FILE nor DATABASE_URL is set" >&2
    return 1
  fi
}
