# OpenWarrant preservation integration

Shared implementation contract:
[OW-WAR-0111](https://github.com/Quitetall/OpenWarrant/tree/1a1048d/docs/warrants/OW-WAR-0111).
This document records the KF side of that scope, not a separate Warrant.

`tests/database/warrant-preservation.test.ts` exercises the public dispatcher and
preservation APIs against two independent PostgreSQL 18 containers. It creates
four fixture Warrants, resolves three, supersedes one, disputes two and annuls
one of the disputed results. Export retains six immutable contract revisions,
action history and audit receipts. The test stops the source container before
importing into the empty migrated target. Re-export must preserve every
manifest-listed section's exact content and the database snapshot digest.

The export uses an ephemeral Ed25519 fixture key. An import without that trusted
key must fail and leave the target without Warrants. These fixture actions and
keys authorize no real project work and confer no OpenWarrant assurance mark.

Run:

```sh
pnpm exec tsc --build
pnpm exec vitest run tests/database/warrant-preservation.test.ts
pnpm exec tsc -p tsconfig.test.json
pnpm exec eslint tests/database/warrant-preservation.test.ts
```

This proves the stated provider database scenario. It does not yet reconnect
external artifact bytes, reconstruct OpenWarrant IR from original source atoms,
cover every Warrant record family, or complete OW-WAR-0111. Provider database
preservation and the experimental OpenWarrant byte archive remain distinct
formats. Complete qualification requires both database and object-store evidence.
