# B2 credentials are read by the parent only, then sent on a bounded stdin pipe.
# This file assumes scripts/lib/secret.sh and ROOT from the selected release.
kf_b2_value() {
  local name="$1" path_name="${1}_FILE" path value credential_name
  case "$name" in
    KF_B2_S3_ENDPOINT) credential_name=b2-endpoint ;;
    KF_B2_BUCKET_NAME) credential_name=b2-bucket ;;
    KF_B2_APPLICATION_KEY_ID) credential_name=b2-key-id ;;
    KF_B2_APPLICATION_KEY) credential_name=b2-key ;;
    *) return 1 ;;
  esac
  path="${!path_name:-}"
  if [ -n "$path" ]; then
    if [ "${KF_SECRET_CUSTODY:-}" = systemd ] && [ "$(basename -- "$path")" != "$credential_name" ]; then
      echo 'B2 credential purpose mismatch' >&2; return 1
    fi
    [ -f "$path" ] && [ ! -L "$path" ] && [ "$(stat -c '%h' "$path")" = 1 ] &&
      [ "$(stat -c '%s' "$path")" -le 514 ] || { echo 'B2 credential input refused' >&2; return 1; }
    value="$(kf_read_secret_file "$path" "$path_name")" || return 1
  else
    [ "${KF_SECRET_CUSTODY:-}" != systemd ] || { echo 'B2 systemd credential file missing' >&2; return 1; }
    value="${!name:-}"
  fi
  [ -n "$value" ] && [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || return 1
  printf '%s' "$value"
}

kf_b2_transport() {
  local verb="$1" path="$2" digest="$3" identity="${4:-null}"
  local endpoint bucket key_id application_key
  endpoint="$(kf_b2_value KF_B2_S3_ENDPOINT)" || return 1
  bucket="$(kf_b2_value KF_B2_BUCKET_NAME)" || return 1
  key_id="$(kf_b2_value KF_B2_APPLICATION_KEY_ID)" || return 1
  application_key="$(kf_b2_value KF_B2_APPLICATION_KEY)" || return 1
  endpoint="${endpoint%/}"
  [[ "$endpoint" =~ ^https://s3\.[a-z]{2}-[a-z]+-[0-9]{3}\.backblazeb2\.com$ &&
     "$bucket" =~ ^[a-z0-9][a-z0-9-]{4,61}[a-z0-9]$ &&
     "$key_id" =~ ^[A-Za-z0-9._/+~=-]{16,512}$ &&
     "$application_key" =~ ^[A-Za-z0-9._/+~=-]{16,512}$ ]] || {
    echo 'B2 configuration refused' >&2; return 1;
  }
  # The admitted credential alphabet has no quote, backslash or control byte. Neither values
  # nor other workstation-store environment entries are forwarded on the child's environment.
  printf '{"format":"kf-offsite-request-v1","configuration":{"endpoint":"%s","bucket":"%s","applicationKeyId":"%s","applicationKey":"%s"},"copy":%s}\n' \
    "$endpoint" "$bucket" "$key_id" "$application_key" "$identity" |
    env -i PATH="$PATH" LANG=C.UTF-8 node "$ROOT/packages/export/dist/offsite-cli.js" "$verb" "$path" "$digest"
}
