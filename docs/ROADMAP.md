# Knowledge Fabric roadmap to completion

The single entry point for finishing the Knowledge Fabric. If you were told "read
docs/ROADMAP.md and continue", this page tells you what KF is for, how to work here, which
Warrant is next, and what only the owner can do.

Each milestone is an OpenWarrant **Warrant** under `docs/warrants/`, and the Warrant holds the full
specification: intent, basis, work order, milestones and obligations. This page orders them and
does not repeat them. Live state comes from the generated corpus status, never from this page:
[CORPUS_STATUS.md](warrants/generated/CORPUS_STATUS.md) and
[WARRANT_OVERVIEW.md](warrants/generated/WARRANT_OVERVIEW.md).

Written 2026-10-07 from the plan the owner approved that day, against `origin/main` at `6a6419dc`
plus ADR 0039.

## 1. Essence

**KF gives every person and every agent in an organization exactly the knowledge their role
entitles them to, as one living document, and every contribution flows back into that same record,
accepted once someone with authority verifies it.** Everything else is that idea worked out:

- **Scope is the product.** What you know is what you have been granted. Roles are composable
  presets of scope, and your master document is your scope compiled. The CEO's, an engineer's and a
  friend's are the same mechanism with different grants.
- **One record, one truth.** A form, an agent writing through MCP, a note captured on a phone: each
  lands as an attributed act in the same record, under the same rules. No side channels.
- **Authority turns contribution into truth.** Anyone, agents included, can draft and submit
  cheaply. The record tells submitted from verified, and a person with authority makes the
  difference, by default with one click.
- **Joining is being granted scope, then qualifying.** You get a role, so your scope holds what you
  need to read, and you qualify by doing one real piece of work through the same record.
- **Agents are colleagues under the same rules.** They read their person's slice, act on that
  person's behalf, and are recorded as doing so. Nothing leaks past anyone's grants, and restricted
  knowledge never leaves the host.
- **Everything is legible.** Readable as a calm document, searchable, traceable to its source, and
  a refusal can be explained.

The hardening, the specification, the fixtures, search and retrieval all serve that.

## 2. How to work here

For an agent session picking this up cold:

1. **Read this page, then the corpus status.** [CORPUS_STATUS.md](warrants/generated/CORPUS_STATUS.md)
   says which Warrants are draft, authorized or resolved. `war next` and `war frontier` (below)
   list what can start.
2. **Take the next milestone.** It is the **first row of the Milestones table (§3) whose Warrant is
   not resolved and whose dependencies are all resolved.** Today that is still **M0, KF-WAR-0002**:
   M0 to M5 are built (§3, "Status"), and no Warrant is resolved until the owner authorizes and
   resolves it.
   Warrant numbers are not the order: KF-WAR-0001 is numbered first because it was written first,
   but it is M6 and depends on M0. `war next` and `war frontier` know each Warrant's internal
   milestone order but not the order between Warrants; this table does.
3. **Check its state.** `war status KF-WAR-000N`. Every Warrant here is **draft** until the owner
   authorizes it (`war sign KF-WAR-000N`). If yours is draft, say so to the owner, it is the first
   item of his queue (§6); prepare the work on a branch meanwhile, and record no evidence against
   the Warrant and merge nothing until it is authorized.
4. **Follow its atoms**, in order: `atoms/10-intent.md`, `atoms/20-basis.md`,
   `atoms/40-work-order.md`, `atoms/45-milestones.yaml` (the stages and their order) and
   `atoms/60-assurance.md` (the obligations, each with its checks, evidence and falsification). The
   rendered whole is the Warrant's generated WAR.md, linked from the table in §3.
5. **Run its gates.** Each obligation names the checks that produce its evidence. Only one gate is
   registered, `gate://kf.host.commissioning@1.0.0` (`docs/gates/kf.host.commissioning@1.0.0.yaml`);
   every other gate a Warrant mentions is a _candidate_, named and not registered.
6. **Record evidence** in the Warrant (`war evidence record` for gate runs), and leave every
   human-only act for the owner: authorizing, accepting, signing, approving, allocating, accepting
   cutover, resolving. List them in your report; never perform one.

### House rules

- Read `CONTRIBUTING.md`, and SAS §3 (what the specification is and what governs it). The
  specification, `docs/sas/KF_Software_Architecture_Specification.md`, is the authority on program
  state; where this page and it disagree, it is right.
- **A guard must be able to fail.** Plant the violation, see the guard fail by name, restore.
- **Never hand-type a count.** Counts come from a script or a generated file, and a measurement is
  run to a file and its exit status tested before anything is claimed or committed.
- **Gaps are recorded, never marked**: in SAS §100, an ADR or a named warning, never an inline
  marker.
- **`war`**: use the build at /mnt/2tb/cargo-target-kf-war/release/war (OpenWarrant `d758574a`, the
  commit CI pins in `.github/actions/provision-war/action.yml`), not whatever is on `PATH`. The
  released 1.0.0-alpha.2 leaks `**` into the normative projection and reports drift for its own
  defect.
- **Worktrees for concurrent writers.** Branch from a freshly fetched `origin/main` into a worktree
  of your own. Other sessions hold other worktrees; check who owns one before touching it, and never
  reset another writer's checkout.
- **Commits**: `git commit -F <file>`; no push, merge or signature unless the owner asks.
- **The fixture stacks**: Véracier on :3100 and multi on :3200 (`fixtures/veracier/README.md`,
  `fixtures/multi/README.md`). Run them from the main checkout and use `restart`, not `up`.
- **Before committing**: `war compile`, `pnpm -s measurements:build`, `node apps/api/dist/cli.js overview`,
  then `war check --generated`, the relevant `npx vitest run` suites and `pnpm -s format:check`.

### What only the owner does

Authorizing and resolving a Warrant; accepting a SAS revision or an ADR; signing anything
(`war sign`, `pnpm ontology:approve`); approving a schema or qualification pack; allocating an
identifier; declaring an agent; creating people, identity links and role assignments with the owner
credential; accepting cutover; cutting the tag; and supplying accounts, hosts and keys. The list in
`CONTRIBUTING.md` ("What is not yours to do") is the authority.

## 3. Milestones

Order is top to bottom. "Depends on" names milestones that must be **resolved** first.

| #   | Milestone                                                                      | Warrant                                              | Roadmap ref                           | Depends on                          | Owner-only steps                                                                                                                   | Done when                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0  | **Close-out**: land everything in flight                                       | [KF-WAR-0002](warrants/KF-WAR-0002/generated/WAR.md) | `KF-PHASE-9/m0-close-out`             | —                                   | sign draft.8 after adding his `ssh_principal`; accept draft.9 and ADRs 0038, 0039; merge OW PR #133; confirm key custody (§100.39) | SeaweedFS and the B2/tailnet work on `main` on Codex's schema; stacks migrated; engine `26923afb` installed; SAS re-proposed; every gate green but owner items                        |
| M1  | **Spec the experience**: ADR 0040 and a SAS UX section                         | [KF-WAR-0003](warrants/KF-WAR-0003/generated/WAR.md) | `KF-PHASE-10/m1-experience-spec`      | M0                                  | accept ADR 0040 and the revision; decide its open choices                                                                          | the twelve decisions are an ADR and numbered requirements, each unbuilt part a §100 entry, and KF-WAR-0004 to 0007 implement them                                                     |
| M2  | **Agents as colleagues**: KF MCP server, verification policy, Needs you        | [KF-WAR-0004](warrants/KF-WAR-0004/generated/WAR.md) | `KF-PHASE-10/m2-agents-as-colleagues` | M1                                  | declare his agents; set any policy beyond "verification required"                                                                  | an agent reads its person's slice through MCP and writes unverified, attributed acts; institutional acts only queue; Needs you verifies in one click                                  |
| M3  | **Scope is the product**: role presets, master document, dashboard             | [KF-WAR-0005](warrants/KF-WAR-0005/generated/WAR.md) | `KF-PHASE-10/m3-scope-is-the-product` | M1                                  | accept the grant-view change; define the real roles                                                                                | roles compose acyclically into the one grant view with an explained path; the master document is scope compiled; one dashboard, calm or compact, works on a phone; §100.42/.43 closed |
| M4  | **The agent at home**: in-app chat, routing by classification, notifications   | [KF-WAR-0006](warrants/KF-WAR-0006/generated/WAR.md) | `KF-PHASE-10/m4-agent-at-home`        | M2, M3                              | supply a provider key or none; set the threshold; decide digest and urgent kinds                                                   | chat answers with citations and withheld counts, restricted never reaches a provider, forms are drafted for one click; digest and push leak nothing; §100.44/.45 closed               |
| M5  | **Joining**: qualification built (ADR 0038), Start Here, invite, first warrant | [KF-WAR-0007](warrants/KF-WAR-0007/generated/WAR.md) | `KF-PHASE-10/m5-joining`              | M3, M4                              | accept ADR 0038; approve packs; sign the re-cut schema pack; create the first invitees                                             | a Véracier CEO and aero engineer go from invite to an accepted first contribution; ADR 0038's nine tests pass with their plants                                                       |
| M6  | **Host**: Phase 9 commissioning on the VPS (ADR 0039)                          | [KF-WAR-0001](warrants/KF-WAR-0001/generated/WAR.md) | `KF-PHASE-9/exit`                     | M0 (and M2 to M5 for a useful host) | rent the VPS; Tailscale; B2 buckets and keys; SSH; confirm an alert and a real login                                               | `kf-commissioning` reports every check satisfied, again after a reboot, on the VPS; nothing public but the tailnet                                                                    |
| M7  | **Owner correctness and user pass** on the hosted instance                     | [KF-WAR-0008](warrants/KF-WAR-0008/generated/WAR.md) | `KF-PHASE-10/m7-owner-pass`           | M6                                  | the whole pass; judging it complete                                                                                                | every finding fixed with a test, moved to a named Warrant, or recorded as decided; every latency bar has a host figure                                                                |
| M8  | **v1.0**: Phase 10                                                             | [KF-WAR-0009](warrants/KF-WAR-0009/generated/WAR.md) | `KF-PHASE-10/exit`                    | M7                                  | accept cutover; sign the pack; accept the §100 dispositions; settle independent verification; cut the tag                          | every ADR 0004 criterion met, every open §100 entry closed or accepted, CI green on the tagged commit                                                                                 |

**Status, 2026-10-07: M0 to M5 are built; their owner-only acts are outstanding.** The work of
each is on `main` through PRs #14 to #22 (M0: SeaweedFS, the tailnet and B2; M1: ADR 0040 and SAS §24B; M2: the KF MCP
server, the verification policy and Needs you; M3: role presets, the overview, the master
document and the dashboard; M4: the in-app agent, routing by classification and notifications; M5:
qualification, `kf invite` and Start Here), and the specification records it as built (SAS §24A,
§24B, §100). Every Warrant is still **draft**, so none is resolved and the order above still
starts at M0. Two "Done when" items were not met as written: §100.42 and §100.43 (M3) are still
open, and §100.45 (M4) is narrowed, not closed, because the choice of fusion is the owner's (§5).
What each milestone still needs from the owner is in §6.

**Why everything before v1.0 sits under Phase 10.** SAS §98 numbers phases 0 to 10 and the
roadmap grammar caps a phase number at 10 (§100.17, §100.24), so nothing new can be numbered. The
grammar does allow a slug after the phase, `roadmap://<PREFIX>-PHASE-<N>/<slug>`, and only the
`exit` slug has a meaning. So M0 is a slug under Phase 9, beside KF-WAR-0001's `exit`; M1 to M5
and M7 are slugs under Phase 10, beside KF-WAR-0009's `exit`. Work after v1.0 has no phase at all;
it is scheduled on this page, which is the workaround §100.24 needs.

**Requirements M1 has not written yet.** `war check` refuses a Warrant that implements a
requirement §106 does not hold. KF-WAR-0004 to 0006 therefore implement only existing
requirements today, and KF-WAR-0003 adds the new UX requirements to them when it lands. KF-WAR-0007
already implements KF-SAS-RQ-254 to 261 (qualification, in the proposed draft.9).

## 4. The experience

Decided by the owner on 2026-10-06 in answer to seventeen questions; summarised here as twelve
decisions. **Normative since M1:** [ADR 0040](decisions/0040-the-experience-scope-is-the-product.md)
and SAS §24B (RQ-262 to RQ-276) are the authority; this summary is not.

1. **Who it is for, in order.** The owner first, then engineers, then friends and others being
   onboarded so they can join. Agents are first-class from the start.
2. **Two surfaces.** Agents read and write KF through a KF MCP server (Claude Code, LAMU, Codex); the
   web app is home, can talk to an agent and drive agentic sessions. LAMU answers locally; a
   provider's model can be used where classification allows.
3. **Home.** A dashboard with the person's views and master document, and a chat window for
   questions answered from the record and forms filled automatically. Several pages, not one.
4. **Agents submit; authority verifies.** An agent's form is a draft committed by one click; MCP
   agents capture freely, attributed to them acting for their person, and what they write is
   unverified until someone with authority verifies it. The policy is configurable per record kind
   and per agent, defaults to verification required, and never auto-verifies an institutional act;
   an institutional act an agent proposes waits in its person's Needs you.
5. **One dashboard for everyone, scoped by grants.** Panels: Overview and master document, Needs
   you, Work in flight, Recent record, People and qualification. Empty panels collapse; someone
   still qualifying sees Start Here first. No screen branches on a role.
6. **The master document is your scope compiled.** The living org overview is a generated record
   above the personal master record, reaching a person only when it is in their scope; hand-written
   documents likewise. A person with no grants still has a master record, without the overview.
7. **Roles are composable scope presets.** A role is a preset on a person's scope ("an engineer gets
   all engineering documents"); roles contain other roles and can be subsets or supersets. This is
   what "curated views" means.
8. **Joining is qualification.** An invite link leads to sign-in and a Start Here page of five
   stages, with the agent as guide and a small real warrant as the first contribution. Understand
   the project in the first hour; a first accepted contribution on the first day.
9. **Notifications.** A daily email digest of Needs you, and an immediate ntfy push only for
   urgent items, on the same path as the alerts. Quiet by default.
10. **Phone.** Read, verify or approve in one click, capture text, photo or voice, chat. Heavy work
    is desktop-first but not broken on a phone.
11. **Models by classification.** Per organization: public and internal may go to a provider model;
    confidential and restricted are answered only by LAMU on the host. Every answer says which
    backend answered.
12. **Look and feel.** A calm, reading-first document workspace, with a switch that makes any view
    extremely compact.

Two answers set scope rather than design: what must exist before friends join is the MCP server,
the dashboard with Needs you and verify, in-app chat, Start Here and qualification, search and
semantic search, role-scoped views and the master document (that is M2 to M5); and the spec's home
is an ADR plus a SAS section for now, until OpenWarrant has a native UX document type. The
resequencing of qualification ahead of hosting departs from ADR 0038's "last", and ADR 0040
says so.

## 5. Open gaps: where each goes

Every **open** entry of SAS §100, as the specification on `main` holds it, appears exactly once.
Count it rather than trust it:

```sh
python3 - <<'EOF'
import re
s = open('docs/sas/KF_Software_Architecture_Specification.md').read()
sec = s[s.index('## 100. Known gaps'):s.index('## 101.')]
entries = [(int(n), ' '.join(t.split())) for n, t in re.findall(r'^\*\*100\.(\d+) ([\s\S]+?)\*\*', sec, re.M)]
open_ = sorted(n for n, t in entries if not re.search(r'—\s*closed\.?$', t))
road = open('docs/ROADMAP.md').read()
table = road[road.rindex('<!-- gap-table:start -->'):road.rindex('<!-- gap-table:end -->')]
cited = [int(x) for x in re.findall(r'§100\.(\d+)', table)]
print(len(entries), 'entries;', len(open_), 'open;', len(cited), 'cited;',
      'missing', sorted(set(open_) - set(cited)), 'duplicated', sorted({x for x in cited if cited.count(x) > 1}),
      'not open', sorted(set(cited) - set(open_)))
EOF
```

Measured when this page was written: **44 entries, 10 closed, 34 open; 34 cited, none missing,
none duplicated, none closed.** Measured again after the closing pass of M0 to M5 (2026-10-07):
**61 entries, 21 closed, 40 open; 40 cited, none missing, none duplicated, none closed.** After the agent guide (§100.61 closed, §100.63 added): **62 entries, 22 closed, 40 open; 40 cited, none missing, none duplicated, none closed.** After the M8 code pass (§100.32 and §100.35 closed, §100.64 and §100.65 added): **64 entries, 24 closed, 40 open; 40 cited, none missing, none duplicated, none closed.** After the host rehearsal (§100.10 narrowed, §100.66 to §100.68 added): **67 entries, 24 closed, 43 open; 43 cited, none missing, none duplicated, none closed.** "Open" means the entry's title does not end "— closed". §100.20
does not exist.

<!-- gap-table:start -->

| Milestone                          | Entries                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0, KF-WAR-0002                    | §100.21 (engine on LAMU `main`; independent verification stays open), §100.39 (key custody, the owner's decision)                                                                                                                                                                                                                                                                            |
| M2, KF-WAR-0004                    | §100.26 (verification's basis is paced; the one-click path must record it truthfully, and the remainder becomes an accepted limit), §100.56 (four readings of M2 for the owner to confirm)                                                                                                                                                                                                   |
| M3, KF-WAR-0005                    | §100.42 (Object View recounts after any write), §100.43 (master-record reads take the whole manifest), §100.60 (photo and voice capture at phone width)                                                                                                                                                                                                                                      |
| M4, KF-WAR-0006                    | §100.45 (narrowed: the choice between the two fusions is the owner's), §100.57 (one urgent-push destination), §100.58 (typed text is not classified)                                                                                                                                                                                                                                         |
| M5, KF-WAR-0007                    | §100.62 (qualification acts with no web gesture), §100.63 (the record envelope is `internal`, the owner's decision)                                                                                                                                                                                                                                                                          |
| M6, KF-WAR-0001                    | §100.4 (replication scheduled nowhere), §100.10 (no host commissioned; rehearsed on a VM), §100.54 (the object store's identities file), §100.55 (object-lock retention, the owner's decision), §100.59 (LAMU's forwarding must stay off on the host), §100.66 (semantic search has no installer), §100.67 (anchor keys, the owner's decisions), §100.68 (owner-command records not indexed) |
| M7, KF-WAR-0008                    | §100.18 (two latency bars include a person; every run is a workstation's; chat integration)                                                                                                                                                                                                                                                                                                  |
| M8, KF-WAR-0009                    | §100.1, §100.3 (narrowed: only the governance pin remains), §100.6, §100.11, §100.13, §100.14, §100.25, §100.27 (narrowed: the rest enumerated in the gate), §100.28, §100.36, §100.64 (views a refused run left), §100.65 (three digest formats wait on the owner)                                                                                                                          |
| Accepted limits (stay, documented) | §100.5, §100.15 (done, a host measurement owed), §100.17 and §100.24 (the phase cap; this page is the workaround), §100.22, §100.23, §100.29, §100.30, §100.33, §100.38                                                                                                                                                                                                                      |

<!-- gap-table:end -->

## 6. Owner action queue

Everything only the owner can do, in the order the milestones need it. `war next` and `war inbox`
list the signing acts live; this is the whole list, including what no tool tracks.

**Now, to unblock M0 and the CI `sas` job**

1. Add his `ssh_principal` to `docs/authority/roles.toml` and an allowed-signers file, then re-sign
   draft.8 (`war sign SAS-0.1.0-draft.8 --ssh-sign`). Until then `war check --generated` reports
   `authority.actor-not-human` as an ERROR on `docs/sas/revisions/0.1.0-draft.8.toml`, which
   `docs/sas/owner-pending.json` does not excuse, so `scripts/war-check-gate.mjs` fails on `main`.
2. Sign the four accepted-but-unsigned revisions draft.4 to draft.7, whose owner-pending entries are
   reviewed by 2026-10-31.
3. Merge OpenWarrant PR #133, then move CI's pinned `war` to an OpenWarrant `main` commit.
4. Authorize KF-WAR-0002 (`war sign KF-WAR-0002`).
5. Confirm key custody (§100.39): `docs/deployment/retrieval-key-release.md` records his choice that
   KF releases the engine's key at startup; the SAS still calls it undecided.

**When M0's PR is ready**

6. Review and merge it; accept SAS draft.9 (`war sign 0.1.0-draft.9`); accept ADR 0038 and ADR 0039. Resolve KF-WAR-0002.

**In parallel, for M6 (no code dependency, long lead time)**

7. Rent the VPS (KVM, about 4 vCPU and 8 GB, Debian 13); create the Tailscale account and join the
   host and his devices; create the two B2 buckets (durable, and object-locked for backups) and their
   keys into the secrets store; give the host SSH access. Authorize KF-WAR-0001.

**For M1 to M5**

8. Authorize KF-WAR-0003; accept ADR 0040 and the revision carrying the UX section; decide its
   open choices (digest time and recipients, urgent kinds, any auto-verify, the classification
   threshold if not the default).
9. Authorize KF-WAR-0004 and KF-WAR-0005; declare his agents; accept the grant-view change; define
   the real organization's first roles.
10. Authorize KF-WAR-0006; supply a provider key or decide on none.
11. Authorize KF-WAR-0007; approve the fixture packs; sign the re-cut schema pack
    (`pnpm ontology:approve`); create the first invitees with the owner credential.

**Found by the closing pass of M0 to M5 (2026-10-07), none of them blocking M6**

- Choose the fused ranking: `kf.fused.rrf.v2`, served now, or `v1` (SAS §100.45).
- Decide object-lock retention on the backup copy: set by the transport, required and checked as
  the bucket's default, or ADR 0039's wording amended (§100.55).
- Confirm or overturn the four readings M2 made (§100.56), and accept ADR 0016's dated note on role
  presets (KF-WAR-0005).
- Decide the digest's send time and recipients and each organization's provider ceiling, and put a
  provider key in the secrets store or decide on none (ADR 0040's open items).
- Decide whether a qualification record's envelope is raised to `confidential` (§100.63).
- Decide whether checkpoint anchors are namespaced per database, and what the B2 anchor key needs (§100.67).
- Decide the three digest formats left by §100.27 (§100.65): tag the registry pack's
  `policy_source_digest` with a registry re-cut he signs; agree a `kf-document-v1` protocol bump
  with Liminal; bump the ML registry's and the master record's digest formats, or accept each as a
  limit.

**For M6 to M8**

12. Confirm receipt of a real alert and complete a real login on the host; resolve KF-WAR-0001.
13. Run the correctness and user pass (KF-WAR-0008) and judge it complete.
14. Accept cutover; sign the v1.0 schema pack; accept the revision with every §100 disposition and
    confirm §100.28's reading; arrange an independent verifier or decide to tag without one; cut the
    tag; resolve KF-WAR-0009.
