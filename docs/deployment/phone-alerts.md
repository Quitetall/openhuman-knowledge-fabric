# Phone alerts without a subscription

The deployment owner chose free hosted ntfy and free Healthchecks, accepting that anyone who
learns a free ntfy topic can read or forge notifications. A long random topic is not an ACL.
Neither alert grants authority nor proves an incident: inspect KF locally before taking action.

The `ntfy-healthchecks` provider sends a fixed generic failure message directly to ntfy. It
sends an empty daily heartbeat to Healthchecks. Healthchecks sends a notification to the same
topic when a heartbeat is missed. A heartbeat cannot clear an unrelated failure notification.
No host/unit names, timestamps, invocation IDs, log commands, record identifiers, logs or
document content are sent by this provider. The existing JSON webhook provider remains the
default for other deployments.

## Urgent items for a person

The same path carries ADR 0040's urgent push (KF-SAS-RQ-274). `kf-notify@urgent.service` runs
`alert-dispatch.sh urgent` when something urgent waits on the person this topic belongs to
(`KF_NOTIFY_PUSH_PERSON` in `/etc/kf/notify.env`): an act an agent proposed for them, or a warrant
blocker opened in their organization. The message is one fixed line, `Something in Knowledge
Fabric needs you. Open Needs you.`, and the response must echo it exactly, as for a failure. It
names no record, person, organization or host. Only urgent items push; everything else waits for
the daily e-mail digest. The notifier reads the same endpoint from
`/etc/kf/notify/alert-webhook-url` (owner `kf-notify`, mode 0600), because the script refuses a file
readable by more than its owner. See [`../agents/in-app-agent.md`](../agents/in-app-agent.md).

## Owner setup

1. Install the ntfy iOS app and allow notifications. Use the hosted `https://ntfy.sh` server.
2. Generate a 32-byte random topic and store the endpoint in the encrypted secret store as
   `KF_ALERT_NTFY_URL`. Do not paste the endpoint into chat, source, a command argument or a
   plaintext file. Inspect it only in your own terminal through `secrets run` to subscribe in
   the app. Do not use a guessable topic such as `kf-alerts`.
3. In Healthchecks, create a check with the generic name **Service heartbeat**. Configure
   a simple period of **1 day** and grace time of **3 hours**, matching the existing daily
   timer's one-hour random spread and 27-hour silence limit. This is daily detection, not an
   immediate host outage alarm.
4. Add the ntfy integration to that check: hosted server, the random topic, and no access token
   for this explicitly public free-topic setup. Keep the check's name and tags generic because
   the integration can include them in notifications. Add email to the same check whenever
   desired; no KF code change is needed for that.
5. Store the check's base HTTPS ping URL (no `/fail`, `/start`, `/log`, or query suffix) with
   `secrets set KF_ALERT_HEARTBEAT_URL`. That command prompts without echoing when run in a
   terminal. Share only the environment name, not its value.

## Host integration

The mode needs both endpoints: `KF_ALERT_WEBHOOK_URL_FILE` for ntfy and
`KF_ALERT_HEARTBEAT_URL_FILE` for Healthchecks. Ordinary files must be readable only by their
owner. Explicit systemd custody uses the separate native validator: it admits only PID 1's
root-owned, read-only tmpfs credential mount with an ACL for the exact service UID. A `0440`
ordinary file is still refused; do not chmod a credential mount or weaken that permission rule.
The owner selected the workstation's TPM-backed encrypted secret store for VM startup. The
handoff module is `scripts/deploy/workstation-credentials.mjs`; its v2 interface exports exactly
`KF_ALERT_NTFY_URL`, `KF_ALERT_HEARTBEAT_URL` and `KF_RETRIEVAL_INDEX_KEY_HEX`, never the entire
store. The index key is exactly 64 lowercase hexadecimal characters; it is a separate
credential from the two HTTPS endpoints. All three travel on
SSH stdin, not in command arguments, and the SSH process receives a clean environment without
decrypted keys. SSH requires the pinned VM Ed25519 host key, ignores ambient SSH configuration,
does not forward an agent, and verifies the receiver's source digest before invoking it.

The root receiver accepts only bounded fixed framing. It refuses non-tmpfs destinations,
active swap, symlinked directories, incorrect ownership and widened permissions. It publishes
one complete generation atomically under `/run/kf-workstation-credentials/current`, with
directory mode `0700` and file mode `0400`, tied to the current guest boot ID. It emits no values.
The workstation timer checks readiness every 30 seconds, and unlocks the encrypted store only
when credentials are missing. A stopped guest, changed host key or receiver drift fails closed.
Secret rotation requires an explicit `send` rather than relying on the boot readiness check.

Use `deploy/systemd/alert-workstation-credentials.conf` for `kf-alert@.service` and
`deploy/systemd/alert-heartbeat-workstation-credentials.conf` for
`kf-alert-heartbeat.service`. They use `LoadCredential=` to copy the volatile source into
systemd's per-module credential directory. Neither source endpoints nor a decrypting key are
stored on the VM disk. The heartbeat drop-in retains the readiness timer-liveness check.

All four endpoint drop-ins explicitly select `KF_SECRET_CUSTODY=systemd`. They supply a
service-owned `0700` RuntimeDirectory on `/run`, bind TMPDIR to it, disable cgroup swap and
core dumps, and leave `/proc/swaps` visible to the shell adapter. Each failure instance has
its own runtime directory; the heartbeat has a separate directory. The native policy accepts
only the exact `ntfy-url` and `heartbeat-url` names, with 1–4097 bytes (the handoff's bounded
URL plus an optional newline). The dispatcher still validates HTTPS URL syntax and provider
acknowledgement. These settings are required even though the dispatcher does not use a
database: sourcing the shared secret library initializes its owned temporary password file.

The workstation templates live under `deploy/workstation/`. Render `@SENDER@` and `@CONFIG@`
with absolute paths to the versioned module and its owner-controlled non-secret JSON config.
The config contains only `identityFile`, `knownHostsFile`, `receiverPath` and `secretsCommand`.
The selected VM uses `kfadmin@127.0.0.1:2222`; this adapter deliberately does not route to an
arbitrary host. Enable the timer as a dependency of `kf-host-1.service`. Order the triggered
module after QEMU, not the timer: a timer's default ordering before `timers.target` would make
an `After=kf-host-1.service` timer cyclic at boot.

Install identical module bytes at a digest-versioned path on workstation and VM, outside any
sealed KF release. The VM copy is root-owned and mode `0555`; its config is not a credential.
Installing this host bootstrap is separate from installing an application release, and grants
no document authority. Existing database/signing credentials are not migrated by this fixed
interface. The installed bootstrap is still the two-endpoint v1 digest recorded below;
source v2 does not upgrade that installation automatically. Install matching digest-versioned
sender/receiver bytes and update the owner-controlled config/timer only after provisioning the
selected encrypted-store key. A v1 bundle is refused by v2; no partial alerts-only fallback
can claim retrieval readiness. Keep any existing index on its existing key or explicitly
rebuild the derived index. Real encrypted-store delivery and reboot proof for v2 remain open.

### Alternative for an independently provisioned encrypted-credential host

Use this only if a different credential-unlock mechanism is explicitly selected. The optional
`deploy/systemd/alert-ntfy-healthchecks.conf` belongs in
`kf-alert@.service.d/ntfy-healthchecks.conf`. The separate
`deploy/systemd/alert-heartbeat-ntfy-healthchecks.conf` belongs in
`kf-alert-heartbeat.service.d/ntfy-healthchecks.conf` and includes the required readiness
timer-liveness precheck. Do not use the failure-unit drop-in for the heartbeat.

The empty `ExecStartPre=` replaces the legacy endpoint precheck. Omitting the heartbeat's
timer-liveness precheck would falsely report a working monitoring path when readiness had
stopped. Encrypt credentials on the target host with `systemd-creds encrypt`, reading values
over stdin through an encrypted transport; persist only ciphertext in
`/etc/kf/credstore.encrypted/alert-ntfy-url` and `alert-heartbeat-url`.

Before encryption, verify that the host has an approved credential-unlock mechanism and that
the transport's host key is pinned. Do not silently initialize a persistent plaintext
systemd host credential key as a fallback on a host without a TPM. Encryption at rest
and automatic reboot recovery must both be demonstrated; a working workstation secret store
does not establish either property inside a VM.

Install only with a release containing this provider, preserving release integrity. Do not
edit the installed sealed release in place or treat a successful local test as host deployment.

## Acceptance

- Run an explicit test failure and confirm the generic alert arrives on the locked iPhone.
- Start the heartbeat service and confirm Healthchecks records the ping; no daily success
  notification is sent directly to the phone.
- Exercise a separate short-period test check, withholding its next ping, and confirm the
  missing-heartbeat notification arrives. Do not stop production monitoring for the test.
- Confirm encrypted source custody, volatile guest credentials, active timer, readiness-liveness
  guard and reboot persistence
  on the real host. The owner confirms reception; an HTTP success alone does not prove it.

An endpoint rejection, malformed ntfy acknowledgement, or Healthchecks `OK (not found)` /
`OK (rate limited)` response fails delivery. Three bounded attempts are made. Provider response
bodies and bearer URLs are not printed or put in curl's command arguments.

### Native credential regression check

On an isolated Linux/systemd host with the existing `kf-retrieval` fixture account, compile
the custody helper for that host, then run the root-only
[native alert driver](../../scripts/deploy/test-alert-credentials.mjs) with the fresh helper
path as its sole argument. Its [shell fixture](../../tests/fixtures/systemd-alert-credentials.sh)
calls the actual dispatcher under PID 1 credentials, not an imitation of the secret reader.
Use the build helper's `--credential-custody` option; the ordinary peer helper is a different atom.

The driver exercises four drop-ins and eight cases each: valid failure/heartbeat dispatch,
ordinary-file custody, missing private TMPDIR, inherited PGPASSFILE, empty/oversized endpoint,
non-HTTPS URL, and an unknown credential name. It checks the running cgroup's zero swap
limit, zero core limit, private tmpfs ownership, no transport call on refusal, and password
file/runtime cleanup. The known-public transport accepts only the fixed generic failure
message or empty heartbeat, with the endpoint on stdin, never argv. Networking is disabled.

This is a native custody/dispatcher check, not an installed alert service check. The fixed
heartbeat runtime is relocated to avoid a live service; `%d`/`%i` are explicitly resolved for
the transient units because `systemd-run --setenv` escapes specifiers. Encrypted drop-ins
use public `LoadCredential` fixtures here: encrypted unlock, ExecStartPre timer-liveness,
the `kf-alert` identity, provider delivery, phone receipt, reboot and commissioning each
still need their own actual-host evidence.

On 2026-10-03 the sealed candidate's workstation drop-in refused an actual native credential
mount as mode `0440`, before transport. Four new declaration tests and the expanded native
policy test failed before correction. Adding the explicit custody/runtime profile and endpoint
policies made those regressions pass; the selected VM then passed all 32 native cases using
public fixtures. The first positive native attempt failed in the fixture's transport reader
because the valid curl config lacked a trailing newline; correcting that fixture, not the
dispatcher, produced the pass. No installed release was edited or promoted, and this proof
sent no phone notification. Existing sealed archives and receipts do not attest these new bytes.

## Observed setup, not host commissioning

On 2026-09-30, both endpoint references were present in the workstation's encrypted secret
store. The KF dispatcher sent its fixed generic failure message and an empty heartbeat using
ephemeral input descriptors. Both providers accepted them, and the owner confirmed receipt of
the KF message on the iPhone. The Healthchecks integration's own test had also reached the
phone. No endpoint or topic is recorded here.

The owner then selected workstation custody. The bootstrap module was installed with SHA-256
`33423ce64080782f13f0f96866b54647c2ab7eaa68e2d5a780a090c4913e898d`, outside the sealed
application release. The timer is enabled under the existing lingering workstation account.
Pinned SSH delivered both endpoints to root-owned tmpfs files. An ordinary guest account could
not read the source files, while a transient systemd module using `LoadCredential=` could read
both private credential copies. No values were printed.

A real guest reboot changed boot ID from `5a13783e-0b4d-41a0-8a2c-fade335624d3` to
`256a97d2-cd41-4445-9d73-4ec8f58a82af`; the timer automatically restored both credentials and
the five previously active KF modules returned active. No systemd host credential key was
created. This proves guest-reboot handoff, not a physical workstation reboot or full
commissioning. The VM's ntfy/Healthchecks alert modules and drop-ins have not been installed;
they require the new application release. A missing-heartbeat notification and the VM readiness
guard remain untested.

The handoff's nine tests passed and the full `pnpm gate` passed with 2,853 tests passed and
24 opt-in tests skipped. A value-aware check of the workstation startup journal found neither
endpoint value; the check emitted only its result, not the values or journal contents.

Source v2 was exercised on 2026-10-01 with public values only: eleven tests cover the fixed
three-entry bundle, missing/malformed keys, boot readiness, unchanged generations on refusal,
private tmpfs custody and transport isolation. The selected VM's isolated broker fixture now
obtains its public key through that atomic generation and supplies it through PID 1 to the
actual LAMU client. Wrong UID, sealed data drift and a stopped broker still refuse. This
did not touch the installed v1 bootstrap, encrypted store, real key or alert delivery.

### Actual three-credential delivery — 2026-10-01

The encrypted store had no `KF_RETRIEVAL_INDEX_KEY_HEX`; the selected VM had no installed
LAMU account, service or retrieval index. A new random key was generated in memory and supplied
on stdin to `secrets set`, without a plaintext file, argument or log value. A subsequent
encrypted-store check reported only that the named key was present and valid. No existing
index key was rotated.

The v2 bootstrap with SHA-256
`a57ae5112ed474458f9dc4d306b774792f57ed29ff481661670c003cd8626183` was installed
byte-identically on workstation and guest. The timer was stopped only for its coordinated
configuration/service update, then restarted. Its triggered service exited successfully;
the receiver reported `kf-workstation-credentials-v2 ready`. Both endpoints and the retrieval
key are in a root-owned `0700` generation with root-owned `0400` files. The ordinary guest
account could not read the key. A value-aware workstation startup-journal check found none of
the three credential values and printed only its verdict. The old versioned bootstrap files
remain available; there is no guest persistent plaintext retrieval key or decrypting identity.

This proves actual encrypted-store delivery, not engine installation, reboot recovery of v2,
phone delivery from the VM or commissioning. The application still points to release
`637677e2c5e1`; the full engine and alert modules remain uninstalled.

References: [ntfy publishing](https://docs.ntfy.sh/publish/),
[Healthchecks ping protocol](https://healthchecks.io/docs/http_api/),
[Healthchecks notification setup](https://healthchecks.io/docs/configuring_notifications/).
Credential semantics: [systemd v257 execution configuration](https://github.com/systemd/systemd/blob/v257/man/systemd.exec.xml).
