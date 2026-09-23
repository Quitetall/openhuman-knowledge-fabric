# @kf/validation

A manifest only — this package holds no code, and nothing here blocks anything. JSON Schema and
SHACL shapes are EMITTED by `packages/ontology-compiler` (`emit/interchange.ts`) for other tools;
they are not evaluated at runtime. Referential integrity, cardinality and lifecycle rules are
enforced by the database's constraints and triggers.

Authority: none.
