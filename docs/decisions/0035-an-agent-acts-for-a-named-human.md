# ADR 0035 — An agent acts for a named human on a delegated token, and the ledger says so

- **Status:** proposed 2026-09-24
- **Decision owner:** technical authority
- **Scope:** how an agent authenticates when forming an act on a person's behalf
- **Carries:** KF-SAS-RQ-204; closes §100.19

## Context

ADR 0020's service actor acts for itself and is barred from institutional acts. An agent drafting
and dispatching an act _for_ a person is a different case: the act is the person's, the agent is a
participant. Since ADR 0033 the database binds a person only on an attestation from `kf-attestor`
that the person presented a valid token — so the question is what token an agent presents.

## Decision

1. **OAuth 2.0 Token Exchange (RFC 8693).** The agent holds its own client credential and
   exchanges the person's token for a delegated one whose `sub` is the person and whose `act`
   claim names the agent's client. Keycloak issues it; the person's consent is the exchange.
2. **`kf-attestor` verifies the `act` claim** alongside everything it already verifies, and the
   attestation records the agent's client id. An `act` claim naming a client that is not a declared
   agent in the realm is refused.
3. **The ledger records participation.** `core.action.agent_participation` holds the agent's
   client id (null for a person acting directly), written by the database from the attestation,
   never by the caller. The act remains the person's: actor, role, clearance and grants are theirs.
4. **An agent never holds more than the person.** Everything it does binds as the person; the
   service-actor bar is unaffected.

## Options rejected

- **The agent as a service actor with a "for" field.** The field would be caller-asserted, and
  service actors cannot perform institutional acts — so the agent could not do what the person can.
- **The agent reusing the person's own token.** Indistinguishable from the person; RQ-204 requires
  the participation to be recorded.
- **A KF-specific signed delegation.** Reinvents token exchange outside the identity provider that
  already authenticates the person.

## How we will know

An act dispatched through the exchange carries the agent's client id in `agent_participation`; the
same act with a plain token carries null; a forged `act` claim, or one naming an undeclared client,
is refused by the attestor (tests at each seam).

## Consequences

Keycloak's token-exchange feature must be enabled for the agent clients; commissioning checks it.
The `core.action` row gains one column; the audit digest is unchanged by this decision.
