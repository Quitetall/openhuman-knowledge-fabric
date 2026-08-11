# @kf/audit

Writes append-only audit events and builds signed Merkle checkpoints over them. The signing
key is not reachable from the API process.

Authority: audit rows may not be updated or deleted through application roles (§13).
