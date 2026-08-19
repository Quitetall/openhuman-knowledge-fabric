# Identifier and configuration policy

**This directory is canonical.** It is the machine-readable companion to `OH-DOC-000001-3` R01,
the Identifier and Configuration Registry, and it is what `OH-DOC-000001-3` §15.3 calls for
under "Machine-readable policy and ontology".

§12.1 of that document settles which way the dependency runs:

> The authoritative registry is structured data validated against an approved ontology and
> schema. […] The DOCX/PDF edition is a controlled human-readable representation of policy and
> selected registry views.

So the `.docx` is a rendering and these files are the thing. §12.1's discrepancy rule is
explicit that a disagreement between the two is a nonconformance to be corrected, "not resolved
by silently choosing whichever view is convenient".

| File              | Defines                                                                           |
| ----------------- | --------------------------------------------------------------------------------- |
| `namespaces.yaml` | The 20 enterprise namespaces (§4.2) and which grammar each uses                   |
| `grammars.yaml`   | Enterprise, record, serial, revision, SemVer, UUIDv7 and filename patterns (§B.1) |
| `damm.yaml`       | The check-digit table (Appendix A), its worked vectors, and negative vectors      |
| `codes.yaml`      | Product families, role mnemonics, document-kind codes — and every retired code    |
| `rules.yaml`      | R1–R18 (§4.3), each with where it is actually enforced or why it is not           |
| `lifecycle.yaml`  | Identity lifecycles and disposition vocabulary (§4.4, §13.3, §13.4)               |

```sh
pnpm ontology:registry-check    # validate. Never writes.
pnpm ontology:registry-pack     # emit release/openhuman-registry-<version>/
```

## Why this is separate from `ontology/`

`ontology/` defines what a Knowledge Fabric object _is_ — object types, relations, actions,
state machines — and is the companion to `OH-DOC-000002-1`. This directory defines how anything
in the organisation is _identified_, and is the companion to `OH-DOC-000001-3`.

§1.1 of the registry lists them as two of six coordinated authorities, with deliberately
different change frequencies: identifier policy changes "rarely; controlled revision", while
the ontology is "versioned; generated and tested". Folding them into one pack would mean a
registry revision forcing a schema bump and the reverse, which is the coupling that separation
exists to avoid.

They do overlap in one place, and it is checked rather than assumed: `grammars.yaml`'s
`uuid.pattern` and `enterprise` pattern must agree with `ontology/meta.yaml`'s `uuid_pattern`
and `enterprise_id.any_of_patterns`. The pack builder fails if they diverge.

## What this directory does not do

**It does not allocate.** R18: "A grammar string, example, draft value or generated preview does
not allocate an enterprise identity." Every identifier that appears here is an example from the
registry document or one of the two already issued (`OH-DOC-000001-3`, `OH-DOC-000002-1`). The
allocation ledger lives in `openhuman-quality/registry/allocations.yaml`, and until the §15.2
bootstrap is approved every entry in it is `proposed`.

**There is no atomic allocator yet.** R6 requires sequences to be "atomically allocated"; no
sequence table or allocation service exists. That is R01 §17 Phase 1 work and is recorded as a
partial enforcement in `rules.yaml` rather than left to be discovered.

## Provenance

Transcribed from `OH-DOC-000001-3-R01_Identifier_and_Configuration_Registry.docx`, dated
2026-08-19, converted with pandoc 3.10.2. Section numbers in the comments refer to that
revision. The document is third-party controlled material and is **not** committed here — it is
referenced by identifier and revision, in the same way vendor datasheets are.

Its own identifier and the Knowledge Fabric specification's were both verified against
`damm.yaml`'s table before this directory was written: `000001` → 3 and `000002` → 1, matching
`OH-DOC-000001-3` and `OH-DOC-000002-1`. That check is now part of the pack builder so it cannot
quietly stop being true.
