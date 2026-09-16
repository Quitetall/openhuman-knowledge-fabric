# Why `docs/sas/generated/` is not here

`war compile` emits `NORMATIVE.{md,json}` — every normative sentence of the specification with its
section — and the file's own header instructs agents to read it **instead of** the document.

It was compiled on 2026-09-16 and removed the same day. It held 134 of the specification's 162
requirements. The 28 it dropped were every requirement in a lettered section: §8A, §8B, §48A, §64A
and §64B. Among them was KF-SAS-RQ-021, the rule forbidding container synchronisation — which this
program had spent two rounds of design reasoning on that same week. An agent reading the projection
would have concluded no such rule existed.

`war check --generated` passed over it throughout. Drift-checking proves a compilation is
**reproducible**, not that it is **complete**: a deterministic extractor drops the same sentences
every time, so a fresh compile matches the committed one. The check was doing exactly what it says.
Nothing else was looking.

Reported upstream. The projection returns when a compiler parses lettered sections, and
`tests/deployment/normative-projection.test.ts` refuses to let it return incomplete — it compares
the projection against every identifier the specification declares, and fails naming each absent
one.

Until then: read the document. It is seven times the size and it is all there.
