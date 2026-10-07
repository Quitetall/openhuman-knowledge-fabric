# First host runbook (KF-WAR-0001, ADR 0039)

The ordered commands to install and commission the first host: a rented KVM VPS on a Tailscale
tailnet, SeaweedFS as its working store, Backblaze B2 for durable copies and off-site backups.
Every command here was run, in this order, on a Debian 13 KVM guest shaped like that VPS on
2026-10-07, with stand-ins for the parts only the owner has (Tailscale, B2, the alert endpoint,
Keycloak); what that rehearsal found and fixed is
[`docs/warrants/KF-WAR-0001/evidence/rehearsal-2026-10-07.md`](../warrants/KF-WAR-0001/evidence/rehearsal-2026-10-07.md).
[private-host.md](private-host.md) is the contract and says why each step is what it is; this page
is the order.

Conventions. `$` lines run on the workstation, `#` lines on the host as root. **Secrets are files,
0600, written by the owner from the encrypted store (`secrets run --`), never typed on a command
line and never printed.** Where a step needs one, it names the FILE it goes in and the
environment name it is kept under in the owner's store; no secret value appears anywhere here.
Everything not marked **OWNER** is done by a program.

KF-WAR-0001 is a draft. Nothing below may be recorded as evidence against it until the owner
authorizes it (`war sign KF-WAR-0001`).

## 0. Before the host exists (OWNER)

1. Rent the VPS: full virtualisation (KVM), about 4 vCPU and 8 GB, Debian 13. Keep the provider
   console login; it is the second way in. Write down the provider, plan and instance id: the
   commissioning record names the machine ([deliverable 7](../warrants/KF-WAR-0001/evidence/uncovered-controls.md), entry 1).
2. In Tailscale's admin console: turn on MagicDNS and **HTTPS Certificates**.
3. In Backblaze B2: three private buckets in one region, each with its own application key —
   the **backup** bucket (object lock on; key from [backup custody](backup-custody.md)), the
   **durable** bucket (versioning; key with listBuckets, listFiles, readFiles, writeFiles, no
   deleteFiles) and the **checkpoint anchor** bucket (versioning; the rehearsal found the signer's
   conditional create needs read as well as write on it — confirm a B2 key with `readFiles` and
   `writeFiles` accepts `If-None-Match`, and record what it can do). Keep each key in the
   encrypted store, e.g. `KF_B2_DURABLE_KEY_ID`/`KF_B2_DURABLE_KEY`,
   `KF_B2_ANCHOR_KEY_ID`/`KF_B2_ANCHOR_KEY`.
4. Decide Keycloak's place on the tailnet host (its own HTTPS on the tailnet address, or a
   reviewed nginx server for it). This repository does not configure it.

## 1. Host requirements (on the VPS, as root)

```sh
# apt-get update && apt-get install -y curl ca-certificates gnupg rsync acl bubblewrap pandoc \
    python3 lsb-release xz-utils nftables util-linux nginx-light
# apt-get install -y --no-install-recommends texlive-latex-base texlive-latex-recommended \
    texlive-fonts-recommended lmodern
```

PostgreSQL 18 client AND server from PGDG, with the key pinned by digest exactly as
`.github/actions/provision-host/action.yml` does (`PGDG_KEY_SHA256` there), then
`apt-get install -y postgresql-18 postgresql-client-18`. Debian's package creates and starts
cluster `18/main`; leave it.

Node at `/usr/bin/node`, the version the release names in its `BUILD-METADATA` (`node=`), not the
one CI pins: `runtime_version` compares against the release. From nodejs.org, checking the
tarball against `SHASUMS256.txt` (verify that file's signature too), then
`install -m 0755 node-v<version>-linux-x64/bin/node /usr/bin/node`.

**OWNER — Tailscale.** Install from pkgs.tailscale.com, `tailscale up`, approve the host in the
console, join your devices. Confirm `ssh <host>.<tailnet>.ts.net` works before section 6.

## 2. Build once on the workstation, promote byte for byte

```sh
$ cd <a fresh checkout of the commit to deploy>
$ CC=musl-gcc KF_PEER_CREDENTIALS_STATIC=1 bash scripts/deploy/build-release.sh
```

It builds in a disposable worktree and runs `pnpm gate` first. On a loaded workstation the gate
can fail on test deadlines rather than on defects (the rehearsal's full-gate build did); run it
when the machine is quiet rather than editing the script. Keep the three files it prints:
`knowledge-fabric-<id>.tar.gz`, `.tar.gz.sha256` and `.manifest.sha256`.

```sh
$ scp knowledge-fabric-<id>.tar.gz knowledge-fabric-<id>.tar.gz.sha256 <host>.<tailnet>.ts.net:/var/tmp/
# cd /var/tmp && sha256sum --check --strict knowledge-fabric-<id>.tar.gz.sha256
# cd /opt && tar --no-same-owner --no-same-permissions -xzf /var/tmp/knowledge-fabric-<id>.tar.gz
# cd / && env KF_EXPECTED_DBMATE_VERSION=2.35.0 \
    KF_EXPECTED_RELEASE_MANIFEST_SHA256=<the digest in .manifest.sha256> \
    KF_EXPECTED_RELEASE_OWNER_UID=0 \
    /opt/knowledge-fabric-<id>/scripts/deploy/install-release.sh install /opt/knowledge-fabric-<id>
```

`install-release.sh` verifies the tree against that digest, switches `/opt/kf` by one rename and
writes `/var/lib/kf/commissioning/release-verification.json`.

## 3. Provision, then the database

```sh
# cd / && /opt/kf/scripts/deploy/provision-host.sh
```

This makes the twenty service accounts, every directory and env file, every machine-made secret,
the checkpoint key, SeaweedFS (pinned binary) and its identities, **the `kf` database with one
login per service and its 0600 connection string**, the planner settings, the disposable
rehearsal cluster `18/rehearsal`, the nginx site and its boot-order drop-in for the tailnet
address, the release digest and receipt path in `/etc/kf/migrator.env`, and the public origins
from the tailnet name. It ends with what only you can supply.

Rehearse the migration on the disposable cluster, apply it, then drop the cluster:

```sh
# cd / && sudo -u kf-migrator bash -c 'set -a; . /etc/kf/migrator.env; set +a;
    KF_MIGRATION_LOCK_FILE=/var/lib/kf-migrator/migration.lock \
    KF_REHEARSAL_DATABASE_URL_FILE=/etc/kf/migrator/rehearsal-database-url \
    KF_REHEARSAL_DISPOSABLE_CLUSTER_CONFIRMATION=dedicated-disposable-cluster \
    KF_REHEARSAL_TARGET_LABEL=vps-18-rehearsal \
    KF_REHEARSAL_RECEIPT_KEY_FILE=/etc/kf/migrator/rehearsal-receipt-key \
    KF_COMMISSIONING_EVIDENCE_DIR=/var/lib/kf/commissioning \
    KF_EXPECTED_RELEASE_OWNER_UID=0 \
    /opt/kf/scripts/deploy/migrate-release.sh rehearse-rollback /opt/kf "$KF_ROLLBACK_REHEARSAL_RECEIPT"'
# systemctl start kf-migrate.service
# pg_dropcluster --stop 18 rehearsal
```

## 4. What only you supply (OWNER), each into its file

Each secret travels from the workstation's encrypted store to its file through a pipe — never an
argument, never a file on either disk in between, never printed (the rehearsal moved the B2
stand-in's keys exactly this way):

```sh
$ secrets run -- sh -c 'printf %s "$KF_B2_DURABLE_KEY"' |
    ssh <host>.<tailnet>.ts.net 'sudo sh -c "umask 077; cat > /etc/kf/storage/s3-durable-secret &&
      chown kf-storage:kf-storage /etc/kf/storage/s3-durable-secret"'
```

Every file `provision-host.sh` created as a placeholder is already 0600 and owned by the account
that reads it; writing into it keeps both. After each input, `provision-host.sh --check` drops
that line.

| What                       | Where                                                                                                                                                                                                        |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Certificate permission     | `TS_PERMIT_CERT_UID=kf-tls` in `/etc/default/tailscaled`, then `systemctl restart tailscaled`                                                                                                                |
| Debian's default site      | `rm /etc/nginx/sites-enabled/default && systemctl restart nginx` (restart, not reload)                                                                                                                       |
| Identity issuer            | `OIDC_ISSUER`, `OIDC_JWKS_URI` in `/etc/kf/api.env` (copied to the attestor and the web by provisioning)                                                                                                     |
| Alert endpoint             | `/etc/kf/alert/webhook-url` (0600 `kf-alert`); copied for the urgent push by provisioning                                                                                                                    |
| SMTP relay for the digest  | `/etc/kf/notify/smtp.json` (0600 `kf-notify`)                                                                                                                                                                |
| Preservation signing key   | private key `/etc/kf/backup/preservation-manifest-key` (0600 `kf-backup`), public half `/etc/kf/preservation-trust.d/<id>.pub`, `PRESERVATION_SIGNING_KEY_ID=<id>` in `/etc/kf/backup.env`                   |
| Backup recovery key        | `provision-host.sh --generate-recovery-key /root/kf-recovery-secret.asc`, then move that file to the custodian offline and `shred -u` it                                                                     |
| Off-site backup (B2)       | `KF_OFFSITE_DESTINATION=b2`, `KF_OFFSITE_LABEL=<label>` in `/etc/kf/offsite.env`; the key arrives by [B2 credential custody](b2-credential-custody.md) and [drill delivery](drill-b2-credential-delivery.md) |
| Durable store (B2)         | `S3_DURABLE_ENDPOINT`, `S3_DURABLE_REGION`, `S3_DURABLE_ACCESS_KEY_ID`, `S3_DURABLE_BUCKET` in `/etc/kf/storage/storage.env`; secret `/etc/kf/storage/s3-durable-secret`                                     |
| Checkpoint anchor (B2)     | `CHECKPOINT_S3_ENDPOINT`, `CHECKPOINT_S3_REGION`, `CHECKPOINT_S3_ACCESS_KEY_ID`, `CHECKPOINT_S3_BUCKET` in `/etc/kf/checkpoint.env`; secret `/etc/kf/checkpoint/anchor-secret-access-key`                    |
| sshd on the public address | after `ssh <host>.<tailnet>.ts.net` works: `ListenAddress <tailnet IPv4>` in `/etc/ssh/sshd_config.d/`, restart ssh — or decide to keep it and record why                                                    |

Then the certificate:

```sh
# systemctl enable --now kf-tls-renew.timer && systemctl start kf-tls-renew.service
# provision-host.sh --check
```

An rsync off-site destination instead of B2 (the rehearsal used one) needs two more owner acts,
which `--check` names: pin the destination's host key in `/etc/kf/offsite/known_hosts` and
`/etc/kf/drill/known_hosts` after comparing its fingerprint with the destination's own console,
and add `/etc/kf/offsite/ssh-key.pub` and `/etc/kf/drill/ssh-key.pub` to the destination account's
`authorized_keys`.

## 5. Services, then the owner's first records

```sh
# systemctl enable --now kf-objects.service && systemctl start kf-objects-init.service
# systemctl enable --now kf-attestor.service kf-api.service kf-worker.service kf-web.service
# curl -s http://127.0.0.1:4000/ready
```

**OWNER — first records.** Owner commands read the schema owner's credential, which on this host
is the migrator's (`DATABASE_OWNER_URL_FILE=/etc/kf/migrator/database-url`, run as root):

```sh
# cd /opt/kf/apps/api
# E="env NODE_ENV=production DATABASE_OWNER_URL_FILE=/etc/kf/migrator/database-url /usr/bin/node"
# $E dist/bootstrap-organization.js --legal-name '<legal name>' --person '<your name>'
# $E dist/grant-authority.js --person <person> --organization <org> --role <role> \
    --clearance restricted --granted-by <person> --issuer <OIDC_ISSUER> --subject <your sub> --reason '<why>'
# $E dist/declare-service-actor.js --organization <org> --name storage-steward --role <role> \
    --classification restricted --declared-by <person> --reason '<why>'
```

Put the service actor's `person_id` and `role_assignment_id` in `/etc/kf/storage/storage.env`
(`KF_STORAGE_ACTOR`, `KF_STORAGE_ROLE`, with `KF_STORAGE_ORGANIZATION`). Declare the recovery
objective (deploy/systemd/README.md, "Declare the recovery objective first") as the migrator, and
approve the three physical failure domains (`ops.physical_failure_domain_evidence`: the VPS disk,
the B2 durable bucket, the B2 backup bucket). Records written this way do not pass through the
outbox, so index them once: `select search.rebuild();` as the migrator.

## 6. Timers, then every scheduled operation once by hand

```sh
# systemctl enable --now kf-checkpoint.timer kf-backup.timer kf-storage.timer kf-audit-verify.timer \
    kf-restore-drill.timer kf-readiness.timer kf-alert-heartbeat.timer \
    kf-notify-digest.timer kf-notify-urgent.timer
# systemctl start kf-checkpoint.service kf-audit-verify.service
# systemctl start kf-backup.service          # pulls in kf-backup-offsite.service; wait for it
# journalctl -u kf-backup-offsite -o cat | tail -3     # "copied and verified"
# systemctl start kf-restore-drill.service   # "restore fully verified", "drill complete"
# systemctl start kf-storage.service kf-alert-heartbeat.service kf-readiness.service
```

Key isolation, as every other account (OBL-003):

```sh
# for u in kf-api kf-web kf-worker kf-attestor kf-backup kf-offsite kf-readiness kf-storage kf-drill; do
    printf '%s: ' $u; sudo -u $u cat /etc/kf/checkpoint/checkpoint-key >/dev/null 2>&1 && echo READ || echo refused; done
```

**OWNER — the firewall**, only once ssh over the tailnet works: include
`/opt/kf/deploy/nftables/knowledge-fabric-tailnet.nft` from `/etc/nftables.conf`,
`nft -c -f /etc/nftables.conf`, `systemctl enable --now nftables`. From a machine off the tailnet:
`nmap -Pn -p- <public address>` and `nmap -sU -p 41641 <public address>`; keep the output.

## 7. Commissioning, a reboot, and again

`kf-commissioning` with this host's values (`KF_RELEASE_ID` is the 12-character release id the
receipts name; add `udp:68` to `KF_PUBLIC_LISTEN_ALLOWED` only if the provider assigns the public
address by DHCP):

```sh
# R="$(readlink -f /opt/kf)"; H="$(sed -n 's/^KF_TAILNET_HOSTNAME=//p' /etc/kf/tailnet.env)"
# cd /opt/kf/packages/operations && env \
    KF_SYSTEMD_DIR=/etc/systemd/system KF_SHIPPED_UNIT_DIR=/opt/kf/deploy/systemd \
    KF_PUBLIC_HOSTNAME="$H" KF_TLS_CERTIFICATE=/etc/kf/tls/tailnet.crt KF_TLS_PRIVATE_KEY=/etc/kf/tls/tailnet.key \
    KF_IDENTITY_ISSUER=<OIDC_ISSUER> KF_IDENTITY_CLIENT_ID=knowledge-fabric-web \
    KF_IDENTITY_POLICY=<the reviewed realm export> KF_IDENTITY_POLICY_SHA256=<its digest at review> \
    KF_REVERSE_PROXY_CONFIG=/etc/nginx/sites-available/knowledge-fabric.conf \
    KF_PRIVATE_LISTEN_ADDRESSES="$(tailscale ip -4),$(tailscale ip -6)" \
    KF_RELEASE_DIR="$R" KF_RELEASE_ID="${R##*/knowledge-fabric-}" \
    KF_EVIDENCE_DIR=/var/lib/kf/commissioning \
    KF_EXPECTED_NODE_VERSION="$(sed -n 's/^node=v//p' "$R/BUILD-METADATA")" \
    /usr/bin/node dist/commissioning-cli.js --json > /var/lib/kf/commissioning/commissioning-$(date -u +%Y%m%dT%H%M%SZ).json
# /usr/bin/node /opt/kf/packages/operations/dist/commissioning-cli.js --send-test-alert   # OWNER: confirm a person received it
```

Then **reboot without watching**, and afterwards: `journalctl --list-boots`, `systemctl --failed`,
`provision-host.sh --check`, the commissioning command again, the port scan again, and a sign-in
through the real identity provider (OWNER). `kf-commissioning` exiting 0 with nothing
`unverifiable`, before and after the reboot, is OBL-005.

## Where the rehearsal stopped

On the rehearsal VM, after a reboot, nine of eleven checks were satisfied. The two that were not:

- `secret_posture`: `/etc/kf/notify/smtp.json` was empty (OWNER, the SMTP relay) and the retrieval
  engine's index key was absent, because semantic search is not installed by anything in this
  repository yet (`provision-host.sh --check` says so; see the rehearsal record).
- `public_exposure`: sshd on `0.0.0.0:22`/`[::]:22` (OWNER, section 4) and the DHCP client on
  `udp:68` (allow it deliberately, as above).

`provision-host.sh --check` ended with exactly three items: the SMTP relay, sshd, and semantic
search.
