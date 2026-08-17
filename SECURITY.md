# Security

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository: **Security → Report a
vulnerability**. That channel is chosen deliberately over an email address — an address in a
security policy that nobody monitors is the same failure this project refuses elsewhere, a
default that goes nowhere. GitHub's form reaches the maintainers and creates a private thread
with a record.

Please do not open a public issue for a suspected vulnerability.

There is no bug bounty and no guaranteed response time. This is a small project; you will get a
human answer, not an SLA.

## What is in scope

The Knowledge Fabric is an **institutional records system**. The things worth attacking it for,
and the controls that exist for each, are enumerated in
[`docs/threat-model/README.md`](docs/threat-model/README.md) — T1 through T8, each with where
the control lives and what proves it. That document is the best starting point for a report,
including its **Residual risk** and **Not mitigated** paragraphs, which say plainly what is not
defended.

Particularly interested in:

- anything that lets a record be changed without an action, an actor and an approval;
- anything that lets a reader see a record outside their organization or above their
  classification ceiling — row-level security is the boundary, and
  [`docs/decisions/0003-typed-table-row-security.md`](docs/decisions/0003-typed-table-row-security.md)
  records exactly how far it reaches;
- anything that forges, replaces or bypasses a checkpoint signature;
- anything that gets the document compiler to execute outside its sandbox.

## What is out of scope

- **Anything requiring a commissioned host, because there isn't one.** No deployment of this
  software exists. [`docs/deployment/private-host.md`](docs/deployment/private-host.md) lists
  what would have to be true first, and says of itself that it "must not be cited as proof that
  the Knowledge Fabric is an institutionally authoritative service".
- **PHI handling.** Protected health information never enters this system. There is no
  PHI-handling capability to find a flaw in.
- The example hostnames, credentials and keys in `docker-compose.yml`, `*.example` files and
  test fixtures. They are public on purpose and are refused outside development by
  `KF_DEPLOYMENT_PROFILE`.
- Findings from a scanner with no demonstrated path to one of the above.

## Supported versions

None yet. There is no released version; `main` is the only branch and nothing is tagged. When
v1.0 exists, the criteria it will have met are in
[`docs/decisions/0004-production-release.md`](docs/decisions/0004-production-release.md).
