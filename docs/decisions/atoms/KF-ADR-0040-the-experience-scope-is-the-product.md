---
schema: oh.war/atom/v1
adr_uuid: 6099e732-2b21-5da0-aba6-cf4c38b2761c
local_alias: KF-ADR-0040
role: adr
jurisdiction: bound
order: 30
classification: public
status: proposed
decided: 2026-10-07
---

# ADR KF-0040: The experience: scope is the product; agents submit, authority verifies

- **Status:** proposed 2026-10-07
- **Decision owner:** the owner, in a seventeen-question grilling on 2026-10-06; recorded here by
  the technical authority
- **Scope:** what a person and an agent experience when they use the Fabric: where they land,
  what they read, how they contribute, how a contribution becomes trusted, how they are told
  something needs them, and how a new person joins
- **Builds on:** [ADR 0014](KF-ADR-0014-corpus-projections.md) (projections),
  [ADR 0016](KF-ADR-0016-access-is-a-grant.md) (grants),
  [ADR 0024](KF-ADR-0024-friction-is-an-architectural-property.md) (friction),
  [ADR 0028](KF-ADR-0028-the-retrieval-index-is-masked-not-copied.md) (nothing controlled leaves
  the host to be embedded), [ADR 0031](KF-ADR-0031-a-draft-is-a-record-that-says-so.md)
  (verification), [ADR 0034](KF-ADR-0034-an-observation-is-captured-then-promoted.md) (capture),
  [ADR 0035](KF-ADR-0035-an-agent-acts-for-a-named-human.md) (agents act for a named human),
  [ADR 0038](KF-ADR-0038-qualification-is-evidence-against-a-versioned-pack.md) (qualification)

## Context

The pieces of an experience existed before anyone described the experience. ADR 0024 made
capture and retrieval speed architectural. ADR 0034 built a one-gesture capture path on three
surfaces. ADR 0035 let an agent act for a named person on a delegated token. ADR 0031 made
"verified" a recorded fact, separate from lifecycle. ADR 0038 designed qualification. Each was
decided on its own, and none said where a person lands, what they read first, or how an agent's
contribution becomes something the organization relies on.

The web application grew page by page out of the API: search, object pages, documents, a capture
form, projects, ML runs and the context picker. It works, and it meets several of ADR 0024's
bars. Nobody designed its screens, and nothing it does can be checked against a description of
what it is for, because there was none.

The owner was asked, one question at a time, on 2026-10-06. The answers reduce to one sentence:

> **The Fabric gives every person and every agent exactly the knowledge their role entitles them
> to, as one living document, and every contribution flows back into that same record and
> becomes trusted when someone with authority verifies it.**

What follows is that sentence worked out. The primary users, in order, are the owner, then
engineers, then invited friends and anyone who must be brought in to contribute. Agents are first
class throughout: they read through the Fabric and write back to keep a clean record.

## Decision

1. **The surfaces are an agent and a web home.** A person works through an agent — Claude Code,
   LAMU, Codex — that reads and writes the Fabric over a KF MCP server, and through the web
   application, which is the home screen. The web application does everything the agent can,
   holds an agent of its own, and is where a person reads, reviews and verifies.

2. **One dashboard, scoped by grants.** Everyone gets the same layout: the overview, their master
   document, Needs you, Work in flight, Recent record, and People & qualification. Each panel
   shows only what the viewer's grants reach, and an empty panel collapses. A person whose
   qualification is open sees Start Here first. There is no owner screen, engineer screen or
   friend screen: they are the same screen with different grants.

3. **A master record is scope, compiled.** A person's master document is their scope compiled
   and nothing else. The living organization overview and any handwritten handbook are ordinary
   records. They reach a reader only by being in that reader's scope. A person granted nothing
   receives a master record and no overview. A person granted the overview receives a master
   record that includes it. The overview is generated from the record. Each statement links to
   its source, and it is evaluated over the reader's own corpus, so it says nothing the reader
   could not read.

4. **Roles are composable scope presets.** A role is a preset of scope: assigning the engineer
   role gives a person the engineering documents, and assigning the CEO role gives them what a
   CEO's master document should hold. Roles contain other roles and may be subsets or supersets
   of each other. Inclusion is a directed acyclic graph, and the database refuses a cycle. A role
   is a less manual way to grant scope, projected into the same grant view every read and write
   consults (ADR 0016). It is not a second access mechanism. An explanation of access names the
   role path by which a grant arrived.

5. **Agents submit; authority verifies.** Anything an agent writes — through the in-app agent or
   over MCP — is the named person's act with the agent's participation recorded (ADR 0035), and it
   enters the record unverified (ADR 0031). It becomes trusted when a person with authority
   verifies it, by default with one click from Needs you.

6. **Verification policy is configurable, required by default, and never reaches an institutional
   act.** An organization may decide that some kinds of record, from some declared agents, are
   verified by policy once it trusts them. The default for every kind and every agent is that a
   person verifies. Setting the policy is itself an attributed act. A record verified by policy
   says so, naming the policy, so "verified" keeps its meaning (KF-SAS-RQ-231). An institutional
   act — approve, decide, release, grant — is never performed by an agent on its own and never
   verified by policy. An agent may propose one; it waits in Needs you for the person holding the
   authority.

7. **The in-app agent answers from the record and drafts into it.** It answers with retrieval
   over the reader's own corpus, citing each record it used and saying how many were withheld
   (ADR 0037). When asked to record something, it fills the real form, with the same fields a
   person would see, and the person commits it with one click. Captures may later be set to
   commit without the click once the person trusts the agent. Institutional acts always wait for
   the click.

8. **Which model may read what is decided by classification.** `public` and `internal` content
   may go to a provider's model where the organization's configuration permits. `confidential`
   and `restricted` content is answered only by a model on the host — LAMU — and never sent off
   it, with no fallback to a provider. Every answer says which backend produced it. This extends
   ADR 0028's rule for embeddings to generation.

9. **Notifications are a digest and an urgent push, quiet by default.** A daily email digest
   lists what needs the person. An immediate push, by ntfy, is sent only for an urgent item: a
   person blocked on the organization, a failed alert, or an act someone is waiting on. Nothing
   else interrupts. The push travels the same path as the operational alerts (§87).

10. **A phone reads, verifies and captures.** On a phone a person can read the dashboard and
    records, verify from Needs you with one click, capture text, a photo or a voice note as an
    observation, and talk to the agent. Heavy work — editing documents, comparing evidence,
    qualification stages — is designed for a desktop, and still works on a phone.

11. **It reads like a calm document, and any view can be made compact.** Reading views are set
    for reading, with generous type, and lists are dense only where a person scans them: queues
    and search results. State is shown by form — verified, unverified, withheld — and not by
    colour alone. A density setting makes any view extremely compact. It changes presentation
    only.

12. **Joining is being granted scope, then qualifying.** An invitation link leads to sign-in and
    then to Start Here: the five stages of the person's qualification pack (ADR 0038), generated
    from their qualification record. The in-app agent is the guide. It explains the read-in,
    answers from the record and points at references. Stage five is a small real Warrant the
    person finishes with the agent's help. The target is understanding the project in the first
    hour and a first accepted contribution on the first day. There is no onboarding system beside
    grants and qualification.

The milestone before friends are invited is: the KF MCP server, the dashboard with Needs you and
one-click verification, the in-app agent, Start Here and qualification, search by words and by
meaning, roles as scope presets, and the master document. The order is in the roadmap.

This record is the stopgap the owner chose for where the experience is specified. The owner
intends to ask OpenWarrant for a UX document class so that the experience has a native home. Until
then, this ADR and the specification's §24B carry it.

## Options rejected

- **Role-specific dashboards.** A designed screen per role is a fork per title, and ADR 0038
  rejected the same shape for onboarding. With one layout scoped by grants, a new role needs a
  new preset and no new code.
- **A chat-only home.** The record is read far more than it is asked about, and a conversation is
  a poor place to read a document or verify fifty records. The agent lives on the home screen and
  does not replace it.
- **A read-only MCP server.** An agent that can read and not write leaves the record to whatever
  people take the trouble to retype, which is the failure ADR 0024 was written against. Agents
  write, and authority decides what is trusted.
- **Write without verification.** Letting an agent's writes count as the person's checked word
  would make "verified" mean "an agent wrote it", and an unverified record would become citable
  evidence by default (KF-SAS-RQ-230).
- **A provider model for every classification.** Simpler, and it sends confidential and restricted
  knowledge off the host whenever someone asks a question. The Fabric already refuses that for
  embeddings (KF-SAS-RQ-218), and refusing it for embeddings while allowing it for generation
  would protect the vector and give away the text.
- **A separate onboarding system.** It would duplicate the people, documents, grants and evidence
  the Fabric holds. ADR 0038 rejected it for qualification, and the experience inherits that.
- **Notifying on everything.** Each new item would ping someone, so people would mute the channel
  and an urgent item would then reach no one.

## How we will know

Each is a planted case or a check against the running application:

- **One layout:** the dashboard is rendered for the owner, an engineer and a person with one
  grant. The panel set and order are the same. Only the contents differ, and an empty panel is
  absent. No code path branches on a role or title.
- **Scope, not copies:** a person with no grant gets a master record with no overview. Granting
  them the overview record puts it in their master record with no other change. Revoking the
  grant removes it.
- **The overview cannot leak:** a reader below the classification of one of the overview's source
  records receives an overview that omits that statement and counts it as withheld.
- **Composition:** role A includes role B. Assigning A grants B's scope, and explaining access
  names the path A → B. Making B include A is refused by the database, and so is any longer cycle.
- **Agent writes are unverified:** a record written over MCP, or committed from an in-app agent
  draft, carries the agent's participation and no verification. It appears labelled in every
  projection, and a Warrant cannot cite it.
- **Policy is bounded:** with the default policy, nothing an agent writes is verified without a
  person. A policy that would verify an institutional act is refused when it is set, and an
  institutional act an agent proposes is performed only on the authority holder's explicit
  confirmation. A record verified by policy names the policy.
- **Nothing controlled reaches a provider:** with a provider configured, a question whose
  retrieved context includes a `confidential` record is answered by the on-host model, or
  refused if none is running. The provider receives no request, and the answer names its
  backend.
- **Quiet by default:** a non-urgent item appears in the next digest and causes no push. An urgent
  one causes exactly one push.
- **Phone:** reading a record, verifying from Needs you and capturing an observation succeed at
  phone width with no horizontal scrolling.
- **Joining:** an invited person with a qualification pack lands on Start Here after sign-in, and
  each stage there resolves to a requirement and its evidence.

## Consequences

- **Roles change shape.** Today `org.role` is a flat list of ten seeded names, and an assignment
  carries authority over one scope object. A role becomes a preset of scope with inclusion, and
  an assignment projects the preset's scope into `org.effective_access_grant`. That is a model
  change, made by migration with an ADR note, and the preservation inventory, export and import
  must carry it.
- **Verification policy becomes configurable.** Today every verification is a person's
  `verify_record`. A policy record, scoped per organization, record kind and declared agent, is
  added. A third basis, verified by policy, sits beside `reviewed_individually` and
  `promoted_in_bulk`, and policy changes are attributed acts.
- **Agent tools gain writes.** §82 has described agent tools as reads and one rehearsal, adding
  that a general write tool would be an authority change. This record is that change and keeps
  the guarantee: the KF MCP server exposes a closed list of typed acts, and none accepts a
  caller-supplied action type (KF-SAS-RQ-020).
- **The overview becomes a record.** The living organization overview is a generated record
  granted like any other, and its statements are drawn from each reader's corpus.
- **A model router appears.** The in-app agent chooses its backend by the highest classification
  in its context and discloses the choice. The organization configures whether a provider is
  allowed at all.
- **Notifications are new.** The email digest and ntfy push share the operational alert path for
  delivery. Their content is a separate decision: a notification leaves the host. Until the
  owner decides otherwise, it names the item and links to it, and carries no record content a
  provider model could not receive.
- **Specified before built.** None of this exists at this revision except the parts it builds on.
  The specification's §24B states it as requirements, KF-SAS-RQ-262 to RQ-276, and §100 records
  each unbuilt part against its milestone (M2 to M5).
