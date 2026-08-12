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
  # Defined below. The password moves to a PGPASSFILE and DATABASE_URL keeps everything else,
  # so nothing downstream has to know this happened.
  DATABASE_URL="$(kf_pgpass_url "$DATABASE_URL")" || return 1
  export DATABASE_URL
}

# ---------------------------------------------------------------------------------------
# Keeping the password out of argv.
# ---------------------------------------------------------------------------------------
#
# `psql "postgres://user:pass@host/db"` puts the password in the process's command line, and
# /proc/<pid>/cmdline is readable by EVERY account on the host — a weaker position than the
# environment, which at least requires the same user. That is the exact exposure the rest of
# this file exists to avoid, so it would be strange to reintroduce it one line later.
#
# `kf_pgpass_url` moves the password into a temporary PGPASSFILE (mode 0600, removed on exit)
# and echoes the connection string with the password removed. libpq reads the file, psql never
# sees the secret, and `ps` shows a URL with no credential in it.
#
# One shared file for the whole script, so a script that connects to two databases — the
# restore drill talks to production and to a scratch target — gets both.

# One trap, many hooks.
#
# `trap ... EXIT` REPLACES whatever was registered before it, so a script that sets its own
# exit trap after sourcing this file would silently discard the one that removes the password
# file. Hooks accumulate here instead, and every registration re-installs the same dispatcher.
KF_EXIT_HOOKS=""

kf_at_exit() {
  KF_EXIT_HOOKS="${KF_EXIT_HOOKS}${KF_EXIT_HOOKS:+; }$1"
  # shellcheck disable=SC2064  # expanded now on purpose: the hook list is read at exit.
  trap 'eval "$KF_EXIT_HOOKS"' EXIT INT TERM
}

# Set up AT SOURCE TIME, in the sourcing shell, and never from inside a function that is
# called through command substitution.
#
# `kf_pgpass_url` is used as `URL="$(kf_pgpass_url "$URL")"`, which runs it in a SUBSHELL: an
# export, a variable assignment or a trap installed in there dies with the subshell, and the
# parent would go on with PGPASSFILE unset, the trap missing, and a password file leaking into
# /tmp. Creating the file here means the subshell only ever APPENDS to a path it inherited,
# which does survive.
#
# The cost is an empty 0600 file per run of a script that may not need one. That is the right
# trade for making the invariant unconditional.
kf_pgpass_init() {
  if [ -n "${PGPASSFILE:-}" ] && [ -n "${KF_PGPASS_OWNED:-}" ]; then
    return 0
  fi
  # An operator who set PGPASSFILE themselves keeps it — appending our entries to their file
  # would edit something we do not own, and removing it on exit would be worse still.
  if [ -n "${PGPASSFILE:-}" ]; then
    KF_PGPASS_OWNED=false
    return 0
  fi
  PGPASSFILE="$(mktemp)"
  export PGPASSFILE
  chmod 600 "$PGPASSFILE"
  KF_PGPASS_OWNED=true
  # Removed however the script exits. A leftover file with a production password in /tmp is a
  # worse outcome than the argv exposure this replaces.
  kf_at_exit 'rm -f "$PGPASSFILE"'
}

# Escape the two characters pgpass treats specially within a field.
kf_pgpass_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/:/\\:/g'
}

kf_pgpass_url() {
  _url="$1"

  case "$_url" in
    postgres://*|postgresql://*) ;;
    *)
      # A keyword/value conninfo. Handled by refusing rather than by a second parser: the
      # password would still reach argv, and a helper that silently did nothing here would be
      # the worst of the three options.
      case "$_url" in
        *password=*)
          echo "refusing: an inline password in a keyword/value connection string would" >&2
          echo "reach argv, where every account on this host can read it. Put it in a" >&2
          echo "PGPASSFILE (mode 600) and remove password= from the connection string." >&2
          return 1
          ;;
      esac
      printf '%s' "$_url"
      return 0
      ;;
  esac

  _rest="${_url#*://}"
  case "$_rest" in *@*) ;; *) printf '%s' "$_url"; return 0 ;; esac
  _userinfo="${_rest%%@*}"
  _hostpart="${_rest#*@}"
  case "$_userinfo" in *:*) ;; *) printf '%s' "$_url"; return 0 ;; esac
  _user="${_userinfo%%:*}"
  _pass="${_userinfo#*:}"
  [ -n "$_pass" ] || { printf '%s' "$_url"; return 0; }

  # Percent-encoding is legal in a URI userinfo and libpq decodes it. Rather than reimplement
  # that decoding here and get it subtly wrong, refuse — a pgpass entry built from the encoded
  # form would simply fail to authenticate, and "wrong password" is a miserable thing to debug
  # at the far end of a restore.
  case "$_userinfo" in
    *%*)
      echo "refusing: percent-encoding in the connection string's user:password." >&2
      echo "Set PGPASSFILE yourself and remove the password from the URL." >&2
      return 1
      ;;
  esac

  _hostport="${_hostpart%%/*}"
  case "$_hostport" in
    *:*) _host="${_hostport%%:*}"; _port="${_hostport##*:}" ;;
    *)   _host="$_hostport";       _port='*' ;;
  esac
  [ -n "$_host" ] || _host='*'

  if [ "${KF_PGPASS_OWNED:-}" != "true" ]; then
    # PGPASSFILE belongs to whoever set it. Their entry is presumably already there; ours
    # would be an edit to a file this script did not create.
    echo "refusing: PGPASSFILE is already set, so this password cannot be moved out of the" >&2
    echo "connection string without editing a file this script does not own. Remove the" >&2
    echo "password from the URL — the PGPASSFILE you configured will supply it." >&2
    return 1
  fi
  # The database field is `*`, not the one named in the URL.
  #
  # These scripts do not stay in one database: pg_dumpall connects to `postgres` to read the
  # cluster's roles, the restore drill CREATEs and DROPs a scratch database, and the restore
  # itself targets a third. An entry pinned to the URL's database matches none of those, and
  # the symptom is `fe_sendauth: no password supplied` from whichever tool moved first — which
  # reads like a permissions problem and is not one.
  #
  # The widening is to other databases on the same host, port and user. That is the same
  # server and the same account, which already had this password a moment ago on argv.
  printf '%s:%s:*:%s:%s\n' \
    "$(kf_pgpass_escape "$_host")" "$_port" \
    "$(kf_pgpass_escape "$_user")" \
    "$(kf_pgpass_escape "$_pass")" >> "$PGPASSFILE"

  printf '%s' "${_url%%://*}://${_user}@${_hostpart}"
}

# Sourcing this file arms both: the exit dispatcher and the password file. Scripts do not have
# to remember to, and a script that never handles a password pays one mktemp.
kf_pgpass_init
