# @kf/ontology-compiler

Deterministic compiler: `ontology/*.yaml` → JSON Schema, vocabulary, state machines,
JSON-LD, SHACL, OpenAPI, TypeScript types, SQL registry seeds, documentation.

Authority: `ontology/*.yaml` is canonical. Everything under `generated/` is output and must
never be hand-edited — CI fails on drift.
