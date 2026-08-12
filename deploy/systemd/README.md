# Scheduled operations

Four things have to happen on a schedule, and until they are scheduled they are habits:

| Unit | Interval | What stops being true without it |
|---|---|---|
| `kf-checkpoint.timer` | hourly | The audit log is unsigned past the last run. A rewrite inside that window is undetectable. |
| `kf-backup.timer` | daily 02:00 | Everything exists in one place. |
| `kf-backup-offsite.service` | after each backup | The copy is beside the original; a lost host loses both. |
| `kf-restore-drill.timer` | monthly | Nothing has proven the backups can be read. |
| `kf-readiness.timer` | every 15 min | Nothing notices when any of the above stops running. |

The last one is the one that makes the others real. A backup timer that silently stops is
indistinguishable from a backup timer that is working, right up until the restore — unless
something is checking, and something is failing when the check fails.

## Install

```
sudo cp *.service *.timer /etc/systemd/system/
sudo install -d -m 0750 -o kf -g kf /etc/kf
sudo install -m 0600 -o kf -g kf /dev/null /etc/kf/database-url
sudo install -m 0600 -o kf -g kf /dev/null /etc/kf/checkpoint-key
# put the values in those two files, then:
sudo systemctl daemon-reload
sudo systemctl enable --now kf-checkpoint.timer kf-backup.timer kf-restore-drill.timer kf-readiness.timer
```

`0600` on both is not decoration — `loadSecret()` refuses a secret file with group or other
bits set, so a `644` key file fails at startup rather than working while being readable by
every account on the host.

## Declare the recovery objective first

Every preservation check FAILS until this row exists, on purpose. A schedule cannot be called
sufficient before somebody decides what it has to be sufficient *for*.

```sql
insert into ops.recovery_objective
  (rpo_seconds, restore_drill_days, requires_pitr, declared_by, rationale)
values
  (86400, 90, false,
   (select id from org.person where full_name = '...'),
   'A day of work is recoverable from the contractors'' own submissions and from email, so a '
   'daily logical backup is proportionate. Revisit when the portal becomes the only copy.');
```

`requires_pitr = false` there is a real decision with a real consequence: the recovery point
is the backup interval. Setting it `true` makes `pitr_readiness` check the server's archiving
against that decision, and fail when archiving is off or its last attempt failed. See
[`../postgres/pitr.conf`](../postgres/pitr.conf).

## Failure handling

Each unit has `OnFailure=kf-alert@%n.service`. Write that unit for whatever this deployment
uses to reach a person — there is no default here, because a default that goes nowhere is
worse than an absent one that fails to start.

A timer whose service fails stays failed until it is looked at; `systemctl list-units --failed`
is the query. `kf-readiness` exits non-zero on **degraded** as well as failed, so a stale index
or a lapsed drill surfaces before it becomes the reason a restore does not work.

## Ordering

`kf-backup-offsite.service` is `Requires=`+`After=` the backup and pulled in by
`Wants=` from it, so the copy runs when a backup completes rather than on a clock of its own.
A copy on a separate schedule copies whatever happens to be there, including nothing.

The restore drill picks the most recent backup that has an off-site copy, restores it into a
scratch database, and drops it afterwards. It records the drill against the **production**
ledger — a drill recorded in the scratch database is discarded along with it.
