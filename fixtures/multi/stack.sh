#!/usr/bin/env bash
#
# Every fixture corpus in ONE stack, each loaded as its own KF organization — for searching
# varied data and for testing tenant isolation between organizations.
#
#   fixtures/multi/stack.sh up                # dependencies, migrations, logins, realm, apps
#   fixtures/multi/stack.sh load --sample     # every corpus's sample (or: load, the full ones)
#   fixtures/multi/stack.sh restart|down|status|reset
#
# The Véracier stack script, run under its own compose project and ports, so it never touches
# the Véracier stack (kf-veracier, 3100/4100/18080) or the default one:
#
#   web      http://localhost:3200          API  http://127.0.0.1:4200
#   Keycloak http://localhost:18180         PostgreSQL 127.0.0.1:15532   MinIO 127.0.0.1:19100
#   state    ~/.local/state/kf-multi        (0700; credentials 0600, never printed)
#
# The web application's context picker lists assignments in ONE organization
# (KF_WEB_ORGANIZATION); here that is Redwood Inference. A person of another organization signs
# in the same way and chooses their context with the typed form beneath the picker (organization,
# role assignment, ceiling), which the API validates exactly as it validates a picked one.

set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export KF_STACK_PROJECT="${KF_STACK_PROJECT:-kf-multi}"
export KF_STACK_WEB_PORT="${KF_STACK_WEB_PORT:-3200}"
export KF_STACK_API_PORT="${KF_STACK_API_PORT:-4200}"
export KF_STACK_KEYCLOAK_PORT="${KF_STACK_KEYCLOAK_PORT:-18180}"
export KF_STACK_PG_PORT="${KF_STACK_PG_PORT:-15532}"
export KF_STACK_MINIO_PORT="${KF_STACK_MINIO_PORT:-19100}"
export KF_STACK_MINIO_CONSOLE_PORT="${KF_STACK_MINIO_CONSOLE_PORT:-19101}"
export KF_STACK_EMBED_PORT="${KF_STACK_EMBED_PORT:-8022}"
export KF_STACK_FIXTURE="${KF_STACK_FIXTURE:-all}"
export KF_STACK_ORGANIZATION="${KF_STACK_ORGANIZATION:-Redwood Inference, Inc.}"
# Never inherit the Véracier stack's names: they would point this stack's loader at that one.
unset KF_VERACIER_STATE KF_VERACIER_WEB_PORT KF_VERACIER_API_PORT KF_VERACIER_KEYCLOAK

exec "$here/../veracier/stack/stack.sh" "$@"
