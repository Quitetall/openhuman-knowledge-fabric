#!/usr/bin/env bash
#
# Tell a person that something failed.
#
# Every scheduled unit declares `OnFailure=kf-alert@%n.service`, and until now no such unit
# existed. That was deliberate — `docs/threat-model/README.md` open item 5 records it as "a
# genuine gap", on the reasoning that a default which goes nowhere is worse than an absent one
# that fails to start. This is the thing that closes it.
#
# Usage:  alert-dispatch.sh failure   <unit-name>
#         alert-dispatch.sh heartbeat
#         alert-dispatch.sh urgent
#
# `urgent` is the person-facing push (ADR 0040 decision 9, KF-SAS-RQ-274): kf-notify-urgent sends
# it when something waits on the person this alert path reaches — an act an agent proposed for
# them, or a blocker opened in their organization. It travels this path, to the same endpoint, so
# a person's urgent items and the operational failures reach one phone the same way, and it says
# exactly as little: that something needs them, and nothing about what (no title, no name, no
# record content, no host). The person opens Knowledge Fabric to see it.
#
# WHAT THIS SENDS, AND WHAT IT DELIBERATELY DOES NOT. The payload carries the unit name, the
# host, the time, systemd's own result words, and the invocation id. It carries NO LOG TEXT.
#
# That is a data-boundary decision, not an oversight. A journal excerpt from a failed backup or
# compilation can contain record content, and the destination here is an arbitrary third-party
# endpoint outside this system's control — the one place this repository's rules say record
# content must not go. The invocation id is sent instead, which is strictly more useful: it
# lets whoever receives the alert run
#
#     journalctl _SYSTEMD_INVOCATION_ID=<id>
#
# on the host and read everything, under the host's own access control rather than the
# webhook's.
#
# FAILURE IS LOUD. Delivery is retried, then the script exits non-zero, which marks
# `kf-alert@<unit>.service` failed and leaves it in `systemctl --failed`. It has no `OnFailure=`
# of its own: an alerter that alerts about its own failure through the path that just failed is
# a loop, and on a host where the endpoint is unreachable it is an unbounded one.
#
# Which is why the heartbeat exists. A failed delivery is visible on the host; a delivery path
# that has silently stopped working is not visible anywhere, and nobody notices until an
# incident goes unreported. `kf-alert-heartbeat.timer` sends a daily success ping so the
# RECEIVER can alert on absence. That is the only way to detect a dead alerter, because by
# definition it cannot tell you itself.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/secret.sh
. "$script_dir/lib/secret.sh"

event="${1:-}"
unit="${2:-}"

case "$event" in
  failure)
    if [ -z "$unit" ]; then
      echo "usage: alert-dispatch.sh failure <unit-name>" >&2
      exit 2
    fi
    ;;
  heartbeat)
    unit="${unit:-kf-alert-heartbeat.service}"
    ;;
  urgent)
    # Fixed: the sender is the notifier, and the push names nothing else.
    unit="kf-notify-urgent.service"
    ;;
  *)
    echo "usage: alert-dispatch.sh {failure <unit-name>|heartbeat|urgent}" >&2
    exit 2
    ;;
esac

provider="${KF_ALERT_PROVIDER:-webhook}"
case "$provider" in
  webhook) ;;
  ntfy-healthchecks) ;;
  *) echo "unsupported KF_ALERT_PROVIDER; refusing to send" >&2; exit 2 ;;
esac

url_file="${KF_ALERT_WEBHOOK_URL_FILE:-/etc/kf/alert/webhook-url}"
if [ "$provider" = ntfy-healthchecks ] && [ "$event" = heartbeat ]; then
  url_file="${KF_ALERT_HEARTBEAT_URL_FILE:-/etc/kf/alert/heartbeat-url}"
fi
# Mode-checked exactly like every other secret here: group or other bits mean it is already
# disclosed to another account on this host. A webhook URL is a credential — anyone holding it
# can forge alerts from this deployment, which is worse than being unable to send them.
webhook_url="$(kf_read_secret_file "$url_file" "alert endpoint")"

# HTTPS only, for the same reason the API refuses to serve bearer tokens over clear HTTP: this
# request carries a credential in its URL and says which host is in trouble, which is a useful
# thing for somebody else to learn at exactly the wrong moment.
case "$webhook_url" in
  https://*) ;;
  *)
    echo "$url_file must contain an https:// URL; refusing to send an alert in clear text" >&2
    exit 1
    ;;
esac

# The URL is a bearer credential. Feed curl a validated config on stdin instead of putting
# it in argv, and never echo a provider error body (it can contain the URL or private data).
curl_config="$(printf '%s' "$webhook_url" | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    try {
      const url = new URL(input);
      if (url.protocol !== "https:" || url.username || url.password || /[\s\\\x00-\x1f\x7f]/.test(input)) {
        throw new Error();
      }
      if (process.argv[1] === "ntfy-healthchecks" && (url.search || url.hash ||
          (process.argv[2] === "heartbeat" && /\/(fail|start|log|[0-9]+)\/?$/.test(url.pathname)))) {
        throw new Error();
      }
      process.stdout.write("url = " + JSON.stringify(url.href) + "\n");
    } catch {
      console.error("invalid HTTPS alert endpoint; refusing to send");
      process.exitCode = 1;
    }
  });
' "$provider" "$event")"

# Structured facts from systemd, never log text. `--property` output is `Key=Value` lines; a
# unit that does not exist yields empty values rather than an error, which is the right
# behaviour for an alerter that must not add a second failure to the one it is reporting.
result=""
exit_status=""
invocation=""
if [ "$provider" = webhook ] && command -v systemctl >/dev/null 2>&1 && [ "$event" = failure ]; then
  while IFS='=' read -r key value; do
    case "$key" in
      Result) result="$value" ;;
      ExecMainStatus) exit_status="$value" ;;
      InvocationID) invocation="$value" ;;
    esac
  done < <(systemctl show "$unit" -p Result -p ExecMainStatus -p InvocationID 2>/dev/null || true)
fi

# JSON built by node rather than by string concatenation. A unit name reaches this script from
# systemd's `%i`, and hand-rolled quoting is how an alerter becomes an injection point into
# whatever consumes the webhook.
if [ "$provider" = webhook ]; then
payload="$(
  KF_EVENT="$event" \
  KF_UNIT="$unit" \
  KF_HOST="$(uname -n)" \
  KF_RESULT="$result" \
  KF_STATUS="$exit_status" \
  KF_INVOCATION="$invocation" \
  node -e '
    const iso = new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
    const body = {
      schema: "kf.alert.v1",
      event: process.env.KF_EVENT,
      unit: process.env.KF_UNIT,
      host: process.env.KF_HOST,
      at: iso,
      // Absent rather than empty when systemd had nothing to say, so a consumer can tell
      // "not applicable" from "reported as blank".
      ...(process.env.KF_RESULT ? { result: process.env.KF_RESULT } : {}),
      ...(process.env.KF_STATUS ? { exitStatus: process.env.KF_STATUS } : {}),
      ...(process.env.KF_INVOCATION ? { invocationId: process.env.KF_INVOCATION } : {}),
      // Said in the payload as well as in this file, because the person reading the alert is
      // the person who will wonder where the logs are.
      logs: process.env.KF_INVOCATION
        ? `journalctl _SYSTEMD_INVOCATION_ID=${process.env.KF_INVOCATION}`
        : "journalctl -u " + process.env.KF_UNIT,
    };
    process.stdout.write(JSON.stringify(body));
  '
)"
content_type=application/json
elif [ "$event" = failure ]; then
  # A free ntfy topic is public to anyone who knows its name. The owner explicitly chose
  # generic alerts: not even host/unit names, timestamps, invocation ids or log commands.
  payload='Service needs attention. Check the service locally.'
  content_type=text/plain
elif [ "$event" = urgent ]; then
  # The same stance for a person's urgent item: that something needs them, never what.
  payload='Something in Knowledge Fabric needs you. Open Needs you.'
  content_type=text/plain
else
  # Healthchecks stores POST bodies. Send no metadata, and accept only its exact success
  # response: it can also return HTTP 200 for an unknown or rate-limited check.
  payload=''
  content_type=text/plain
fi

# Bounded, retried, then loud. Three attempts over roughly half a minute: enough to ride out a
# reload at the far end, short enough that a queue of failing units does not pile up behind it.
# `--fail` makes an HTTP error an exit code, so a 4xx from a rotated URL is a failure here
# rather than a success that reached nobody.
attempt=1
while :; do
  if response="$(printf '%s' "$curl_config" | curl --config - --fail --silent \
       --max-time 20 \
       --max-filesize 65536 \
       --header "content-type: $content_type" \
       --data "$payload" \
       2>/dev/null)"; then
    if [ "$provider" = webhook ]; then
      exit 0
    elif [ "$event" = heartbeat ] && [ "$response" = OK ]; then
      exit 0
    elif { [ "$event" = failure ] || [ "$event" = urgent ]; } && printf '%s' "$response" | KF_EXPECTED="$payload" node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => { input += chunk; });
      process.stdin.on("end", () => {
        try {
          const response = JSON.parse(input);
          process.exitCode = response.event === "message" &&
            response.message === process.env.KF_EXPECTED ? 0 : 1;
        } catch { process.exitCode = 1; }
      });
    '; then
      exit 0
    fi
  fi
  if [ "$attempt" -ge 3 ]; then
    echo "alert delivery failed after $attempt attempts for $unit ($event)" >&2
    echo "the endpoint in $url_file did not accept the alert; nobody has been told" >&2
    exit 1
  fi
  attempt=$(( attempt + 1 ))
  sleep 5
done
