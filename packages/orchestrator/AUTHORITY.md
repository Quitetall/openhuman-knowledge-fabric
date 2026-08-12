# @kf/orchestrator

Composition root for action atoms exported by work-control, product-quality and document
packages. Rejects duplicate action ownership instead of choosing by load order.

Authority: owns no facts and performs no writes itself. It composes packages whose writes still
run through `@kf/actions` and PostgreSQL controls.
