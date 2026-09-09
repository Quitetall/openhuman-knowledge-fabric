# Gate-run receipts

Scratch. `war gate --run --record` writes §44.6 receipts here, and **nothing reads them.**

The corpus projection reads gate runs only from each Warrant's own committed `gate-runs/`
directory, so that it reproduces from a fresh clone. A receipt that lived only here would make
the projection depend on one machine's untracked state, which is the failure this arrangement
exists to prevent.

This README is tracked and the receipts are not. The directory has to exist because
`openwarrant.toml` names it and the generated corpus status cites it; its contents are a local
by-product of running a gate, not evidence anybody else can check.
