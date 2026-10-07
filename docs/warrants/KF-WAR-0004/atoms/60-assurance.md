---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-339e-7463-afe2-e09d9261e893
role: assurance
jurisdiction: authored
order: 60
classification: internal
---

# Assurance

No registered gate covers this work. Each obligation names the tests that produce its evidence;
`kf.agents.surface` is proposed below as a candidate gate, not cited as one.

## Acceptance obligations

### OBL-001 — an agent reads exactly what its person may read
- **scope:** KF-SAS-RQ-115, RQ-039, RQ-229.
- **checks:** a new permissions suite in `tests/permissions/` driving the MCP server against a
  real PostgreSQL, with the Véracier personas.
- **evidence:** for each persona, the MCP `search` and `read_record` results equal the API's for
  the same token, member for member, each carrying its verification label.
- **falsification:** plant a record outside the persona's grants and name its id directly; the
  MCP read must return the same uniform not-found as the API (KF-SAS-RQ-252), with no difference
  in body or timing class.

### OBL-002 — no delegation, no access
- **scope:** KF-SAS-RQ-204, RQ-235, RQ-240.
- **checks:** `tests/permissions/attestor.test.ts` extended to MCP sessions.
- **evidence:** a call after the delegation is revoked, with an undeclared agent, or with the
  attestor unreachable, refuses by name and binds nobody.

### OBL-003 — what an agent writes is submitted, not trusted
- **scope:** KF-SAS-RQ-203, RQ-228, RQ-231; the M1 requirement on agent submissions.
- **checks:** database tests on the verification policy.
- **evidence:** every MCP write produces an act whose `agent_participation` names the agent, and
  a record with no `core.object_verification` row unless the policy for that kind and agent says
  `verified_on_submit`.
- **falsification:** set the policy to `verified_on_submit` for an action declared institutional;
  the database must refuse the policy row itself, by name.

### OBL-004 — an agent never performs an institutional act
- **scope:** KF-SAS-RQ-043, RQ-044, RQ-046.
- **checks:** a test that walks every action `ontology/action-types.yaml` declares institutional
  through the MCP write tools.
- **evidence:** every one queues a proposal and performs nothing; performing it requires the
  person's own act, which re-checks grants at that moment.
- **falsification:** grant the agent's person every act grant and retry: still queued, never
  performed.

### OBL-005 — one click, honestly recorded
- **scope:** KF-SAS-RQ-227, RQ-231; SAS §100.26.
- **checks:** web and API tests on the Needs-you route and panel.
- **evidence:** a one-click verify records `reviewed_individually`; a select-many verify goes
  through `POST /verifications/bulk` and records `promoted_in_bulk`, one act per item.
- **candidate gate (not registered):** `kf.agents.surface`, running OBL-001 to OBL-005's suites
  with each falsification planted, qualified the way `docs/gates/kf.host.commissioning@1.0.0.yaml`
  was.

## Gate Adequacy

Required at `controlled` (§39.4).

**Adversarial question: could an agent end up trusted without anyone with authority deciding
it?** Three ways, each an obligation above: a policy row that marks a kind verified on submit for
an institutional act (OBL-003 plants it); a proposal performed by something other than the
person's explicit act, such as an expiry or a bulk accept (OBL-004); and a bulk verify recorded as
individual review (OBL-005). A fourth is out of reach: a person who clicks verify without reading.
SAS §100.26 records that the pace makes a false claim slow and attributed, not impossible.

**Could the checks themselves be blind?** The suites run against a real PostgreSQL, through the
MCP server rather than around it, and each carries a falsification that must fail first.

**Executed attacks:** none yet; this Warrant has not been executed.

- **outcome:** gap_accepted

The paced-not-proven basis of §100.26 stays an accepted limit; nothing here claims a click proves
reading.

## Residual risk

**RR-001 — a person verifies what they did not read.** Accepted, as §100.26 records.

**RR-002 — an MCP client's own context leaks.** What an agent read through MCP sits in that
client's context, outside KF. KF controls what it discloses and records it (KF-SAS-RQ-250); it
cannot control what a client does after.

## Independence

None (`openwarrant.toml`); `war check` reports `independence.insufficient` for this controlled
Warrant, which is the true state.
