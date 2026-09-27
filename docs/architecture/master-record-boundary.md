# Master-record permission boundary

This is the OBL-006 boundary decision for OW-WAR-0054. The machine-readable registry is
[`master-record-boundary.json`](./master-record-boundary.json).

`permission(O,C)` contains only rows materialized into KF-governed tables and admitted by the
active organization/classification RLS context. The registry enumerates every RLS-enabled table
in this checkout. `search.document` is classified separately as a derived projection; its
exclusion is explicit and it is rebuilt from authoritative rows. No table is resolved live from
an external system.

The conformance surface calls `assertMasterRecordBoundaryComplete` against every RLS-enabled
table discovered from migrations. It refuses an unclassified, stale, or multiply classified
table, so adding a governed table without a boundary decision fails before compilation.

Federated and object-store systems remain source boundaries, not hidden members. KF stores their
governed metadata, immutable digest, and versioned locator. External bytes can enter a
master-record claim only after ingestion creates an RLS-governed artifact/version row and the
claim records that digest. A missing mirror is therefore not silently treated as complete.

## Transient observations (§64B, ADR 0029)

A third class sits beside materialized and derived: `transientTables`, each entry naming a table
and its `expiry`. A transient observation is neither authoritative nor rebuildable — a recorded
query observes something that happened once — so on loss it is simply gone, and no restore
procedure may treat it as recoverable. Expiry means nothing unless every copy expires, so
`tests/conformance/transient-observations.test.ts` holds each declared transient table to all four
exclusions of KF-SAS-RQ-220:

- the preservation export — listed in `PRESERVATION_TABLE_EXCLUSIONS`;
- this boundary — declared transient, never materialized;
- checkpoint coverage — named nowhere in `apps/checkpoint/src`, which signs only the audit chain;
- backups — `--exclude-table-data=<table>` in `scripts/backup.sh`, so no dump outlives the window.

A table in the `transient` class that misses any one of the four fails that test.
