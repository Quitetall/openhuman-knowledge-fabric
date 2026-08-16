# KF runtime dogfood proof

Evidence date: 2026-08-15

Repository fixed point: `d1bbf23d11f080c39f68d59131ce4e61f2c81ce5`

Intermediate implementation commit: `2234555ee096292a816f164dbd8210d048ddbc73`

Final implementation commit: commit containing this evidence (use its Git object ID)

## Authority boundary

This run created no approval, enterprise identifier, compiler registration, compilation run,
promotion authority decision, promotion signing key, promotion receipt, promotion revocation or
run seal. It did not accept ADR 0002, sign R01, resolve
`docs/decisions/0001-r01-schema-pack-defects.md`, qualify Liminal, or authorize replacement
cutover.

## Recoverability and forward migration

All retained custom-format backups are mode `0600`:

| Backup                                         |   Bytes | SHA-256                                                            |
| ---------------------------------------------- | ------: | ------------------------------------------------------------------ |
| `/tmp/kf-pre-forward-20260815.dump`            |  976913 | `6073a6d5157fe22d8b25bfeea9b8814bc033255c6b38a0837d9dbe07df2c9a2e` |
| `/tmp/kf-pre-legacy-hardening-20260814.dump`   | 1365590 | `38eb5464c4cabdaad49237711a6991672beebd0c23868f9380a1925e169f54a1` |
| `/tmp/kf-pre-audit-head-20260814.dump`         | 1367049 | `54a3c985123469de8e4029ca834304ff2ca1e0e1592e121044c0fe097b7903a4` |
| `/tmp/kf-pre-schema-convergence-20260814.dump` | 1370753 | `484e57f760abe5a02b25f8f3a520ffb1caa45534f88580fe7c4f4827eccb7dd0` |

- Live database has all 52 migrations through `20260814003000`; this includes path-local
  recovery migration `20260814002550`.
- Fresh-install test applies every migration from zero.
- A disposable empty database received the complete migration sequence. Normalized
  `pg_dump --schema-only --no-owner --no-privileges` output matched live dogfood exactly after
  removing only dump-version lines and PostgreSQL's random `\\restrict`/`\\unrestrict` token.
  Disposable database was removed. Result: `live_schema_matches_fresh_install=yes`.
- Docker dependencies were running and healthy: `kf-postgres`, `kf-minio`, `kf-keycloak`.

## Idempotent constitution replay

Post-migration replay loaded all three constitution documents and their composition with
`replayed: true`. No authoritative count changed:

| Record                                             |        Count |
| -------------------------------------------------- | -----------: |
| Objects / search rows                              |      15 / 15 |
| Document subjects                                  |            4 |
| Authored-fragment revisions                        |            3 |
| Composition revisions                              |            1 |
| Controlled documents                               |            3 |
| Actions / audit events / global audit head         | 11 / 11 / 11 |
| Migration-019 legacy allowlist                     |           11 |
| Pending outbox rows                                |            0 |
| Approvals                                          |            0 |
| Objects with enterprise identifiers                |            0 |
| Document compiler registrations / compilation runs |        0 / 0 |
| ML promotion authority decisions / receipts        |        0 / 0 |
| ML run seals                                       |            0 |

Pinned `kf-artifacts` state remained 34 object versions and zero delete markers after replay.

## Live readiness

`kf-readiness --json` verified schema release, three write guards, complete audit chain, current
outbox, complete search index and federation freshness. Overall readiness intentionally remained
false because human or external evidence does not exist:

- no signed audit checkpoint covers 11 events;
- zero of three required physical failure domains have approved evidence;
- no recovery objective has been declared;
- PITR need and proof therefore remain undecided.

No synthetic row was added to turn these checks green.

## Automated gates

All final gates ran under required Node `24.18.1`:

- `pnpm format:check`: pass
- `pnpm lint`: pass
- `pnpm typecheck`: pass
- `pnpm ontology:check`: pass, 0 errors and 113 warnings; generated digest
  `716e20f4a1b2`
- `pnpm test`: 75 files passed; 901 tests passed; 1 conditional Liminal-adapter test skipped;
  no failures
- `pnpm build`: pass, including Next.js production build
- `pnpm --filter @kf/web test:browser`: 1/1 pass; OIDC, authority context, document workbench,
  access denial and ML projection exercised in Chromium
- `git diff --check`: pass

## Remaining external or human gates

- Real Liminal checkout lacks qualified `kf-document-v1` compiler and ratified HAQP evidence;
  no real compiler was registered or run.
- Real Keycloak realm/client/audience mapper, linked users, role assignments and TLS hostnames
  remain operator commissioning work. Browser proof uses controlled OIDC/API fixtures.
- LamQuant compatibility corpus needs pinned live import, zero-drift evidence, 30-day shadow
  period and human cutover decision.
- Checkpoint key custody, recovery objective, publication target/key custody, provider
  allowlists, PHI admission, physical storage/restore evidence, controlled-document acceptance,
  model promotion and replacement cutover remain with named human or external authorities.
