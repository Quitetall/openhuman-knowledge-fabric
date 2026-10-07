---
schema: oh.war/atom/v1
warrant_uuid: 01a114e0-33a5-7322-8054-141d19584829
role: basis
jurisdiction: authored
order: 20
classification: internal
---

# Basis

- **The host commissioned by KF-WAR-0001** (ADR 0039: a VPS on the tailnet, SeaweedFS, B2, the CPU
  embedder, LAMU `26923afb`), and the product built by KF-WAR-0004 to KF-WAR-0007.
- **ADR 0040** (to be written by KF-WAR-0003): the decisions the pass checks the product against.
- **ADR 0024** and SAS §100.18: two latency bars are unmeasured because each includes a person,
  and every recorded run is a workstation's. This pass is where both change.
- **ADR 0004**: a person receiving an alert and real-provider browser evidence are the two
  blockers no automation can close; KF-WAR-0001 carries them as RR-003.
- KF-SAS-RQ-171: claims needing host, provider or human evidence are outstanding until it exists.

## Existing tools this reuses

- `scripts/latency-bars.mjs` for the bars a script can time, run on the host.
- `kf note` and the web capture form for real observations; `kf overview` for the control record.
- `docs/deployment/phone-alerts.md` for the alert a person receives.
- `docs/deployment/identity-and-login.md` for the real login.

## The unknown

How many findings there will be. The Warrant fixes what is small and moves what is large into a new
Warrant by name, so this one can resolve.
