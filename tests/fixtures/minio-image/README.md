# Retired: the MinIO images built from source

This directory built the MinIO server and client images the OW-WAR-0111 preservation test ran,
from MinIO's pinned release sources, after MinIO archived its community edition and every registry
deleted its images (2026-09). ADR 0039 replaced MinIO with SeaweedFS everywhere; the preservation
and versioning tests now run the `seaweedfs` service docker-compose.yml pins
(`tests/database/preservation-object-store.ts`), and nothing builds or runs MinIO.

The build files are in the history of this path (`git log -- tests/fixtures/minio-image`). This
note stays only because the specification (SAS §100.40) and ADR 0039 still cite the directory; it
goes when they no longer do.
