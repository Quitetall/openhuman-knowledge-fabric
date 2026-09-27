#!/usr/bin/env bash
# Switch the live release atomically, keeping the previous one to roll back to (KF-SAS-RQ-162).
#
# Until 2026-09-25 "switch /opt/kf atomically" and "keep the previous release intact" were two
# sentences in docs/deployment/private-host.md and nothing else. `ln -sfn` is unlink-then-create,
# so the live path briefly does not exist; and "the previous release" was whatever the operator
# remembered its name to be. This script is those two sentences, executable.
#
# Changes files only. It never stops or starts a service and never touches the database: the
# migration is `migrate-release.sh apply`, and when an application-only rollback is allowed is a
# decision the deployment document states, not one this script can make.

set -Eeuo pipefail
export LC_ALL=C

usage() {
  cat >&2 <<'EOF'
usage:
  install-release.sh install RELEASE_DIRECTORY
  install-release.sh rollback
  install-release.sh status

install   verify RELEASE_DIRECTORY with `migrate-release.sh check`, record what was verified, point
          LINK.previous at the live release and LINK at the new one (rename(2), never unlinked).
          Requires KF_EXPECTED_RELEASE_MANIFEST_SHA256, KF_EXPECTED_DBMATE_VERSION and
          KF_EXPECTED_RELEASE_OWNER_UID, as `migrate-release.sh check` does.
rollback  re-verify LINK.previous against its recorded digest and swap the two links.
status    print the live and previous releases and their recorded digests.

KF_INSTALL_ROOT (default /opt) holds LINK and the release directories; KF_INSTALL_LINK (default
kf) names the live link inside it.
EOF
}

fail() {
  echo "install refused: $*" >&2
  exit 1
}

command_name="${1:-}"
case "$command_name" in
  install) [ "$#" -eq 2 ] || { usage; exit 64; } ;;
  rollback|status) [ "$#" -eq 1 ] || { usage; exit 64; } ;;
  *) usage; exit 64 ;;
esac

for tool in readlink mv ln flock sed; do
  command -v "$tool" >/dev/null 2>&1 || fail "required command is unavailable: $tool"
done

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
verifier="$script_directory/migrate-release.sh"
[ -x "$verifier" ] || fail "release verifier is missing beside this script: $verifier"

install_root="${KF_INSTALL_ROOT:-/opt}"
[[ "$install_root" = /* ]] || fail 'KF_INSTALL_ROOT must be an absolute path'
[ -d "$install_root" ] && [ ! -L "$install_root" ] ||
  fail "KF_INSTALL_ROOT is not a real directory: $install_root"
install_root="$(readlink -f -- "$install_root")"
link_name="${KF_INSTALL_LINK:-kf}"
[[ "$link_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail 'KF_INSTALL_LINK must be a plain name'
live_link="$install_root/$link_name"
previous_link="$install_root/$link_name.previous"
state_directory="$install_root/.$link_name-install"

# A link that exists must be a symlink naming a release directory beside it. A real directory at
# the live path is a hand-made install, and replacing it would destroy the only copy.
link_target() {
  local link="$1"
  if [ -L "$link" ]; then
    local target
    target="$(readlink -- "$link")"
    [[ "$target" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
      fail "$link does not name a release directory beside it: $target"
    printf '%s' "$target"
  elif [ -e "$link" ]; then
    fail "$link exists and is not a symlink; move it aside by hand before installing"
  fi
}

record_path() {
  printf '%s/%s.verified' "$state_directory" "$1"
}

record_value() {
  local key="$1" record="$2" count
  count="$(grep -c "^${key}=" "$record" || true)"
  [ "$count" -eq 1 ] || fail "install record $record has no single $key"
  grep "^${key}=" "$record" | cut -d= -f2-
}

# Every release that becomes live is verified first, by the same verifier the deployment document
# gives the operator, with the release's own packaged dbmate.
verify_release() {
  local release_directory="$1" manifest="$2" dbmate_version="$3" owner_uid="$4"
  KF_DBMATE_BIN="$release_directory/tools/dbmate" \
    KF_EXPECTED_DBMATE_VERSION="$dbmate_version" \
    KF_EXPECTED_RELEASE_MANIFEST_SHA256="$manifest" \
    KF_EXPECTED_RELEASE_OWNER_UID="$owner_uid" \
    "$verifier" check "$release_directory" >&2 ||
    fail "release does not verify against its manifest digest: $release_directory"
}

# Point LINK at TARGET with one rename(2): build the new link under a temporary name, then move
# it over the old one. `mv -T` treats the destination as a file even when it is a symlink to a
# directory, so the rename replaces the link instead of moving into the directory it names.
swap_link() {
  local link="$1" target="$2" temporary
  temporary="$install_root/.$(basename -- "$link").$$.new"
  ln -s -- "$target" "$temporary"
  mv -T -- "$temporary" "$link" || {
    rm -f -- "$temporary"
    fail "could not switch $link"
  }
}

acquire_lock() {
  mkdir -p -- "$state_directory"
  chmod 0755 "$state_directory"
  exec 8>"$state_directory/lock"
  flock -n 8 || fail 'another install or rollback holds the lock'
}

case "$command_name" in
  status)
    live="$(link_target "$live_link")"
    previous="$(link_target "$previous_link")"
    for pair in "live:$live" "previous:$previous"; do
      label="${pair%%:*}"
      name="${pair#*:}"
      if [ -z "$name" ]; then
        echo "$label: none"
      elif [ -f "$(record_path "$name")" ]; then
        echo "$label: $name manifest_sha256=$(record_value manifest_sha256 "$(record_path "$name")")"
      else
        echo "$label: $name (not installed by this script: no record)"
      fi
    done
    ;;

  install)
    candidate_argument="$2"
    [ -d "$candidate_argument" ] && [ ! -L "$candidate_argument" ] ||
      fail "release is not a real directory: $candidate_argument"
    candidate="$(readlink -f -- "$candidate_argument")"
    [ "$(dirname -- "$candidate")" = "$install_root" ] ||
      fail "release must sit directly in $install_root, beside the live link: $candidate"
    candidate_name="$(basename -- "$candidate")"
    [[ "$candidate_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
      fail "release directory name is not a plain name: $candidate_name"
    case "$candidate_name" in
      "$link_name"|"$link_name.previous") fail "release directory may not be named $candidate_name" ;;
    esac

    manifest="${KF_EXPECTED_RELEASE_MANIFEST_SHA256:-}"
    dbmate_version="${KF_EXPECTED_DBMATE_VERSION:-}"
    owner_uid="${KF_EXPECTED_RELEASE_OWNER_UID:-}"
    [[ "$manifest" =~ ^[0-9a-f]{64}$ ]] ||
      fail 'KF_EXPECTED_RELEASE_MANIFEST_SHA256 must be one lowercase SHA-256 digest'
    [[ "$dbmate_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
      fail 'KF_EXPECTED_DBMATE_VERSION must be an exact semantic version'
    [[ "$owner_uid" =~ ^[0-9]+$ ]] || fail 'KF_EXPECTED_RELEASE_OWNER_UID must be a numeric uid'

    acquire_lock
    live="$(link_target "$live_link")"
    [ "$live" != "$candidate_name" ] || fail "release is already live: $candidate_name"

    verify_release "$candidate" "$manifest" "$dbmate_version" "$owner_uid"

    record="$(record_path "$candidate_name")"
    record_temporary="$record.$$.new"
    printf 'manifest_sha256=%s\ndbmate_version=%s\nowner_uid=%s\nverified_at=%s\n' \
      "$manifest" "$dbmate_version" "$owner_uid" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      > "$record_temporary"
    chmod 0644 "$record_temporary"
    mv -T -- "$record_temporary" "$record"

    # Previous first: if the second rename failed, the live release would still be live and
    # merely also recorded as previous — never a live link with no way back.
    if [ -n "$live" ]; then
      swap_link "$previous_link" "$live"
    fi
    swap_link "$live_link" "$candidate_name"
    echo "installed: $live_link -> $candidate_name (previous: ${live:-none})"
    ;;

  rollback)
    acquire_lock
    live="$(link_target "$live_link")"
    previous="$(link_target "$previous_link")"
    [ -n "$previous" ] || fail "there is no previous release to roll back to ($previous_link)"
    [ -n "$live" ] || fail "there is no live release ($live_link)"
    previous_directory="$install_root/$previous"
    [ -d "$previous_directory" ] && [ ! -L "$previous_directory" ] ||
      fail "previous release directory is gone: $previous_directory"
    record="$(record_path "$previous")"
    [ -f "$record" ] ||
      fail "previous release $previous was not installed by this script, so there is no recorded digest to verify it against"

    verify_release "$previous_directory" \
      "$(record_value manifest_sha256 "$record")" \
      "$(record_value dbmate_version "$record")" \
      "$(record_value owner_uid "$record")"

    swap_link "$previous_link" "$live"
    swap_link "$live_link" "$previous"
    echo "rolled back: $live_link -> $previous (previous: $live)"
    ;;
esac
