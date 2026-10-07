#!/bin/sh
#
# Create the buckets the Knowledge Fabric writes to and turn S3 versioning on for each, through
# the S3 API, then refuse unless every one of them answers that versioning is Enabled.
#
#   KF_OBJECTS_ENDPOINT                 the store's S3 endpoint, e.g. http://127.0.0.1:8333
#   KF_OBJECTS_REGION                   signing region (default us-east-1)
#   KF_OBJECTS_ACCESS_KEY_ID            an identity allowed to create buckets and set versioning
#   KF_OBJECTS_SECRET_ACCESS_KEY_FILE   its secret, in a file (owner-only on a host)
#   KF_OBJECTS_SECRET_ACCESS_KEY        or the value itself — the public development value only
#   KF_OBJECTS_BUCKETS                  space-separated (default: the four buckets below)
#   KF_OBJECTS_WAIT_SECONDS             how long to wait for the store to answer (default 120)
#
# WHY VERSIONING, AND WHY BEFORE ANYTHING IS WRITTEN. The artifact store records each object's S3
# version id (content.artifact_location.store_version) and reads by it, so a location names THE
# bytes, not whatever is at that key now. Turning versioning on later protects nothing already
# stored, so the buckets are made versioned before the first application starts.
#
# WHY IT CHECKS ITS OWN WORK. "PUT ?versioning returned 200" is not "versioning is on": a store
# whose GetBucketVersioning always answers "not enabled" (Garage, ADR 0039) would pass a script
# that only wrote. The last step reads every bucket back and exits non-zero naming the first one
# that is not Enabled.
#
# Runs under POSIX sh with curl (the SeaweedFS image has both; so does a host). SAFE TO RE-RUN: a
# bucket this identity already owns is kept, and enabling versioning twice is a no-op.
#
# THE SECRET never reaches argv or the output: it is handed to curl as a config file on stdin
# (`-K -`), written by the shell's printf builtin.

set -eu

endpoint="${KF_OBJECTS_ENDPOINT:?KF_OBJECTS_ENDPOINT is not set}"
endpoint="${endpoint%/}"
region="${KF_OBJECTS_REGION:-us-east-1}"
access="${KF_OBJECTS_ACCESS_KEY_ID:?KF_OBJECTS_ACCESS_KEY_ID is not set}"
buckets="${KF_OBJECTS_BUCKETS:-kf-artifacts kf-snapshots kf-checkpoints kf-exports}"
wait_seconds="${KF_OBJECTS_WAIT_SECONDS:-120}"

if [ -n "${KF_OBJECTS_SECRET_ACCESS_KEY_FILE:-}" ]; then
  [ -r "$KF_OBJECTS_SECRET_ACCESS_KEY_FILE" ] || {
    echo "init-buckets: cannot read KF_OBJECTS_SECRET_ACCESS_KEY_FILE" >&2
    exit 1
  }
  secret="$(cat "$KF_OBJECTS_SECRET_ACCESS_KEY_FILE")"
else
  secret="${KF_OBJECTS_SECRET_ACCESS_KEY:?set KF_OBJECTS_SECRET_ACCESS_KEY_FILE}"
fi
# curl's config syntax quotes the value; a quote or backslash in it would end the string early.
case "$access$secret" in
  *'"'* | *'\'* | *"
"*)
    echo "init-buckets: the access key or secret contains a quote, backslash or newline" >&2
    exit 1
    ;;
esac

VERSIONING_ON='<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>'

# s3 <method> <path+query> [curl args...]: body on stdout, HTTP status as the last line.
s3() {
  method="$1"
  target="$2"
  shift 2
  printf 'user = "%s:%s"\n' "$access" "$secret" |
    curl --silent --show-error --max-time 30 -K - --aws-sigv4 "aws:amz:$region:s3" \
      -X "$method" --write-out '\n%{http_code}' "$@" "$endpoint/$target"
}

status_of() { printf '%s\n' "$1" | tail -n 1; }

# The store's S3 gateway answers its health path before its filer can create a bucket, so the
# first real request is retried until it gets an S3 answer at all.
# A 4xx is an answer, and retrying it would only delay the same refusal.
deadline=$(($(date +%s) + wait_seconds))
while :; do
  answer="$(s3 GET '' 2>/dev/null)" || answer="000"
  case "$(status_of "$answer")" in
    200) break ;;
    4??)
      echo "init-buckets: $endpoint refused ListBuckets for $access:" >&2
      printf '%s\n' "$answer" | sed '$d' >&2
      exit 1
      ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "init-buckets: $endpoint did not answer ListBuckets in ${wait_seconds}s" >&2
    exit 1
  fi
  sleep 1
done

for bucket in $buckets; do
  answer="$(s3 PUT "$bucket")"
  case "$(status_of "$answer")" in
    200) echo "created bucket $bucket" ;;
    409)
      case "$answer" in
        *BucketAlreadyOwnedByYou*) ;;
        *)
          echo "init-buckets: bucket $bucket exists and is not this identity's:" >&2
          printf '%s\n' "$answer" | sed '$d' >&2
          exit 1
          ;;
      esac
      ;;
    *)
      echo "init-buckets: creating $bucket failed:" >&2
      printf '%s\n' "$answer" | sed '$d' >&2
      exit 1
      ;;
  esac
  answer="$(s3 PUT "$bucket?versioning" -H 'Content-Type: application/xml' \
    --data-binary "$VERSIONING_ON")"
  if [ "$(status_of "$answer")" != 200 ]; then
    echo "init-buckets: enabling versioning on $bucket failed:" >&2
    printf '%s\n' "$answer" | sed '$d' >&2
    exit 1
  fi
done

# Read every bucket back. Only an explicit <Status>Enabled</Status> passes: an empty
# configuration (never enabled) and Suspended both fail, by name.
for bucket in $buckets; do
  answer="$(s3 GET "$bucket?versioning")"
  if [ "$(status_of "$answer")" != 200 ]; then
    echo "init-buckets: GetBucketVersioning on $bucket failed:" >&2
    printf '%s\n' "$answer" | sed '$d' >&2
    exit 1
  fi
  case "$answer" in
    *'<Status>Enabled</Status>'*) ;;
    *)
      echo "init-buckets: bucket $bucket does not have versioning Enabled" >&2
      exit 1
      ;;
  esac
done
echo "buckets ready with versioning enabled: $buckets"
