# @kf/canonicalization

RFC 8785 (JCS) canonical JSON and SHA-256 digests. Every hash that appears in a snapshot,
manifest, audit event or export is computed here, so two implementations cannot disagree
about what a record's bytes are.

Authority: none — but it is the definition every digest in the system depends on.
