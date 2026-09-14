# @kf/retrieval

Builds the authorization mask a retrieval engine scores under (§64A).

Authority: none. Everything here is derived from `core.object` and from the access grants
resolved for one caller, and is recomputed rather than stored. A band bitmap is a copy of an
authorization input, which KF-SAS-RQ-223 permits only for the life of the process holding it —
so nothing in this package may be written to durable storage of any kind, and the check that
proves it is a test rather than a convention.
