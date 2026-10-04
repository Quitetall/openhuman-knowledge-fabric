# Closed application credential delivery

Six named application roles reuse the standalone workstation sender's pinned
SSH transport and private, boot-bound tmpfs publication. This adds deployment
adapters, not database primitives, compiler behavior or workflow authority.
It does not install consumer service bindings or commission a host.

## Contract

Each row is a separate realm. The encrypted inputs are mandatory; another
role's input never supplies a missing value. The listed native names are in
wire order. There is no arbitrary role, secret-name or credential-export option.

| Role       | Encrypted-store inputs                                                                                                                                    | Native names in order                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| api        | `KF_API_DATABASE_URL`, `KF_API_S3_SECRET_ACCESS_KEY`, `KF_API_S3_DURABLE_SECRET_ACCESS_KEY`, `KF_API_READINESS_TOKEN`, `KF_API_MASTER_RECORD_LINK_SECRET` | `database-url`, `s3-secret-access-key`, `s3-durable-secret-access-key`, `readiness-token`, `master-record-link-secret` |
| worker     | `KF_WORKER_DATABASE_URL`, `KF_WORKER_S3_SECRET_ACCESS_KEY`                                                                                                | `database-url`, `s3-secret-access-key`                                                                                 |
| attestor   | `KF_ATTESTOR_DATABASE_URL`                                                                                                                                | `database-url`                                                                                                         |
| checkpoint | `KF_CHECKPOINT_DATABASE_URL`, `KF_CHECKPOINT_SIGNING_KEY_BASE64`, `KF_CHECKPOINT_S3_SECRET_ACCESS_KEY`                                                    | `database-url`, `checkpoint-signing-key`, `s3-secret-access-key`                                                       |
| storage    | `KF_STORAGE_DATABASE_URL`, `KF_STORAGE_S3_SECRET_ACCESS_KEY`, `KF_STORAGE_S3_DURABLE_SECRET_ACCESS_KEY`                                                   | `database-url`, `s3-secret-access-key`, `s3-durable-secret-access-key`                                                 |
| readiness  | `KF_READINESS_DATABASE_URL`                                                                                                                               | `database-url`                                                                                                         |

`applicationCredentialBindings(role)` returns fresh pairs of consumer setting
name and native credential name. Worker uses `WORKER_DATABASE_URL_FILE`;
checkpoint uses `CHECKPOINT_SIGNING_KEY_PATH` and
`CHECKPOINT_S3_SECRET_ACCESS_KEY_FILE`. Working/durable object credentials retain
the existing consumer setting names, including
`S3_DURABLE_SECRET_ACCESS_KEY_FILE`. API's token/link settings retain their
`KF_` prefix. A consumer still needs the explicit native custody configuration
and the [native credential reader](native-credential-reader.md).

For each fixed role, the wire header is
`kf-workstation-application-<role>-credentials-v1`, followed by exactly one
canonical base64 line per field and a final newline. Decoding refuses extra,
missing, invalid UTF-8 or noncanonical fields, including every sibling and
preexisting realm's header. Bounds belong to each role; the old protocols and
their limits remain unchanged.

Database URLs admit the existing selected-host shape: printable ASCII, at most
8192 bytes, `127.0.0.1:5432`, a named non-template database and only the optional
`sslmode=disable` query. Transport admission does not prove that a database
principal has the correct grants. Object tokens are 1–8192 printable non-space
ASCII bytes; API readiness/link secrets are 32–8192. The checkpoint input is
canonical base64 of a PKCS8 Ed25519 private PEM, at most 4096 decoded bytes.
No preservation signer fallback exists. A separately named input does not,
by itself, prove distinct key material, independent custody or signing authority.

`receive` and `status` require root and the actual empty swap table. Publication
uses `/run/kf-workstation-application-<role>-credentials`: 0700 root/generation
directories, 0400 single-link fields, an exact file set including `boot-id`,
and atomic `current` replacement. Refusal never redirects a sibling's current
generation. Old generations remain retained; publication is not a consumer
restart or rotation of PID 1's already-loaded copy.

## Scheduling and delivery

The only selectors are `application-<role>-receive`, `-status`, `-send`, and
`-sync`, for the six roles above. The receiver remains a single standalone file;
the pinned transport requires identical sender/receiver bytes. An old frozen
receiver cannot receive a new realm. Refreshing it needs the existing reviewed
installation process, not a bypass of hash verification.

`deploy/workstation/kf-host-application-credentials@.service.in` invokes only
`application-%i-sync`. It reuses `@SENDER@` and `@CONFIG@`, sets
`MemorySwapMax=0`, `LimitCORE=0`, and a 55-second timeout. The paired timer retries
every 30 seconds after startup. These templates are not enabled by adding them
to source. They run no consumer, migration, backup or business workflow.

`sync` first asks the pinned receiver for status and, if unavailable, invokes
the configured encrypted store to deliver only that profile. It does not refresh
a ready generation merely because the encrypted store changed. Explicit
`send`, followed by verified consumer restart, is needed for rotation. Secret
values must remain in the workstation's encrypted store and volatile credential
mounts, never source, command arguments, plaintext persistent files or logs.

## Verification and remaining installation

Run the source regression:

```sh
pnpm exec vitest run tests/deployment/workstation-application-credentials.test.ts
```

On a Linux host with root, mount namespaces and an empty swap table, run
`scripts/deploy/test-workstation-application-credentials.mjs` with Node as root
from a protected candidate containing the matching sender. It uses only public
fixture values, publishes under an attempt-owned tmpfs directory, and executes
CLI admission/refusal in private `/run` mount namespaces. It checks maximum
field bounds, exact private sets, sibling/old-realm rejection and isolated
rotation. It removes only its own public fixtures.

This proof does not contact the encrypted store, SSH target, database or object
provider. It proves neither real credential ownership nor installed startup,
effective grants, signing authority, backup recovery or qualification.

The [native application consumer bindings](application-consumer-binding.md)
provide the fixed wrappers and optional service drop-ins in source. Remaining
work: public-only service configuration; verified role-specific database
and object grants; encrypted-store inputs; matching frozen receivers and
selected-host timers; actual PID 1 delivery and consumer start/restart; then
failure/reboot/rotation and end-to-end host commissioning checks. Keep all of
these separate from human approval, promotion and replacement cutover.
