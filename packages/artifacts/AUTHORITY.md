# @kf/artifacts

Artifact and ArtifactVersion lifecycle: presigned upload, SHA-256 verification, immutable
version creation. Bytes live in object storage; identity and provenance live in PostgreSQL.

Authority: PostgreSQL owns artifact metadata; the object store owns the bytes (§2.1, §2.3).
