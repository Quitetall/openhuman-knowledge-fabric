# Draft.9 implementation

Basis: [KF SAS 0.1.0-draft.9](sas/KF_Software_Architecture_Specification.md), proposed source
digest `d0dccd75bc0b8dcda54688a5d2bcfa4be760ff883da556614b40696e81f4c32f`.
Implementation starts from `e6f67fe66e3e34237f67c8ab76c176d822a7232e` in a separate worktree.

The owner requested implementation on 2026-09-30, selected the existing KF VM, and confirmed
that KF releases the retrieval encryption key at startup. The owner selected
`/mnt/2tb/kf-preservation`, on `/dev/sda`, independently of the VM's `/dev/nvme0n1`.
These instructions authorize implementation; they do not create signed acceptance,
schema-pack approval, an identifier allocation or a cutover record.

## Delivery order

1. Restore clean-machine startup (§100.40): build the pinned MinIO releases from verified public
   source, retaining the same provider and shared build recipe. Exercise bucket initialization,
   object versioning and read-back on an isolated stack.
2. Complete the correctness and scale pass: restore invalidates retrieval masks (§100.29);
   context and master-record reads avoid unnecessary full-manifest reads (§100.43); embedding
   runs with bounded concurrency and retryable claims (§100.44). Keep search-quality figures
   visible (§100.45), and treat ranking changes as measured proposals.
3. Implement KF key release (§100.39), with an authenticated local startup seam and no plaintext
   persistent key file owned by the retrieval engine. Prove refusal with a wrong peer, a stopped
   broker and an invalid release. Keys never enter source, command arguments or logs.
4. Promote the tested release onto the existing VM. Exercise the installed services, private
   TLS, identity, checkpoint isolation, off-device encrypted backup, restore, alert delivery and
   reboot; record every commissioning result. Human observations and acceptance remain pending
   until actually received. Qualification follows hosting and the correctness pass (§24A).
5. Build qualification (ADR 0038, §100.41, RQ-254–261): two governed object types, explicit pack
   composition, pinned requirements and revisions, exact evidence modes, credit during work
   acceptance, computed currency, organization blockers, declared action requirements and a
   confidential Start Here projection. Roles remain pack data; qualification grants no authority.
6. Exercise CEO and aero-engineer Véracier packs and every ADR 0038 planted case through the
   same dispatcher, then run the repository gate. Rebuild ontology, preservation inventory and
   measured documentation. Report implementation evidence separately from human release acts.

## Completion evidence

- A clean checkout starts its declared dependency stack without an unavailable image.
- A real authorized user admits a document, finds it by words and requested meaning, reads its
  source and projection, and receives uniform refusals for unauthorized records.
- The selected VM passes commissioning against the exact promoted release after reboot.
- A qualification pack added for a new role requires no code change. Exact evidence and affected
  behavioural revisions change eligibility; permissions remain governed by ordinary grants.
- Full repository gate passes on the resulting implementation. Provider, host, alert-recipient,
  signing and acceptance evidence is claimed only when observed.

## Implementation checkpoint — 2026-09-30

The following is local implementation evidence, not release acceptance or host commissioning:

- The pinned-source object-store smoke test passed bucket initialization, versioning on all
  four declared buckets and exact object read-back. Its isolated stack was removed afterward.
- Embedding requests now run with a validated, bounded concurrency setting, outside database
  transactions. The integration tests demonstrate overlap within the requested bound and
  refusal of invalid settings before any claim is taken.
- The ntfy/Healthchecks provider and guarded systemd drop-ins are implemented. The owner
  confirmed the workstation dispatcher's generic notification on the iPhone; see
  [phone alerts](deployment/phone-alerts.md) for the remaining real-host tests.
- A real Pandoc reader difference exposed an unrecorded source transformation: GFM can replace
  NUL before returning its AST. A failing minimal reproduction and regression tests preceded
  the fix. Text-input replacements now record original byte ranges and retain the original
  source digest; binary inputs are untouched. The regression projection matched on workstation
  and VM Pandoc versions.
- Compatible dependency updates cleared the security audit, including removal of the obsolete
  Vitest exception. The full `pnpm gate` exited successfully: 2,844 tests passed, 24 opt-in tests
  skipped, no known dependency vulnerabilities, generated files unchanged and production build
  successful. The gate still reports six existing fixture lint warnings and 83 ontology
  warnings; neither skipped checks nor a successful gate demonstrate runtime qualification.

The owner subsequently selected workstation encrypted-store custody. A digest-versioned host
bootstrap now supplies only the two alert endpoints into private guest tmpfs, over pinned SSH,
without a persistent plaintext copy or guest decrypting key. Its enabled workstation timer
restored both credentials automatically after a real VM reboot; the previous five KF modules
returned active. A systemd credential-copy probe passed; the ordinary guest account could not
read the root-only source. See [phone alerts](deployment/phone-alerts.md) for exact evidence and
scope. This does not complete the separate retrieval-key release requirement.

The source changes are in `implement/draft9`, not a promoted application release. The VM still
uses its earlier application release; the ntfy/Healthchecks alert drop-ins remain uninstalled.
The remaining correctness pass, retrieval-key release, real-host
commissioning and qualification remain open in the delivery order above. The selected second
drive is independent-device storage, not an off-site copy.

## Recovery checkpoint — 2026-10-01

The [live recovery procedure](backup-and-restore/README.md#live-recovery-stop-permission-cache-holders-first)
now has an executable, persistent interlock. It stops the API, worker and every explicitly
declared external cache-holder unit, refuses starts while held even after reboot, and only
requests fresh processes after the operator confirms recovery verification. Its scope must
include every host using the restored database; undeclared or unmanaged processes are not covered.
It does not mutate the restored snapshot or manufacture a recovery-verification receipt.

Seven coordination tests cover stopping, retry, list retention, unsafe files and names, missing
units, control-group stopping and refusal to resume surviving processes. An opt-in test against
the real workstation user-systemd manager demonstrated that a synthetic cache-holder PID dies,
cannot restart while held, and reads changed classification in a fresh process even though the
restored version token repeats. The existing retrieval and restore-verifier/drill regressions
also passed. No production database was restored and no VM recovery or reboot commissioning is
claimed. Deployment and exact-host recovery proof remain outstanding.
