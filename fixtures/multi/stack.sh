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
#   Keycloak http://localhost:18180         PostgreSQL 127.0.0.1:15532   S3 (SeaweedFS) 127.0.0.1:19100
#   state    ~/.local/state/kf-multi        (0700; credentials 0600, never printed)
#
# The web application's context picker lists every live assignment the signed-in person holds, in
# every organization they hold one in, under its legal name; a person of any organization picks
# their context from it. KF_WEB_ORGANIZATION (here Redwood Inference) only puts that organization
# first. The typed form beneath the picker (organization, role assignment, ceiling) stays as a
# fallback, which the API validates exactly as it validates a picked one.

set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export KF_STACK_PROJECT="${KF_STACK_PROJECT:-kf-multi}"
export KF_STACK_WEB_PORT="${KF_STACK_WEB_PORT:-3200}"
export KF_STACK_API_PORT="${KF_STACK_API_PORT:-4200}"
export KF_STACK_KEYCLOAK_PORT="${KF_STACK_KEYCLOAK_PORT:-18180}"
export KF_STACK_PG_PORT="${KF_STACK_PG_PORT:-15532}"
export KF_STACK_OBJECTS_PORT="${KF_STACK_OBJECTS_PORT:-19100}"
export KF_STACK_EMBED_PORT="${KF_STACK_EMBED_PORT:-8022}"
# The Véracier stack's embedding server, shared: the same model, so one copy in GPU memory, not
# two. The pin refuses it if it is ever not the same. KF_STACK_EMBED_URL= (empty) runs this
# stack's own on KF_STACK_EMBED_PORT. Start the Véracier stack first: with its server down, this
# stack starts lexical-only, and while it stays down this stack cannot embed.
export KF_STACK_EMBED_URL="${KF_STACK_EMBED_URL-http://127.0.0.1:8021}"
export KF_STACK_FIXTURE="${KF_STACK_FIXTURE:-all}"
export KF_STACK_ORGANIZATION="${KF_STACK_ORGANIZATION:-Redwood Inference, Inc.}"
# Never inherit the Véracier stack's names: they would point this stack's loader at that one.
unset KF_VERACIER_STATE KF_VERACIER_WEB_PORT KF_VERACIER_API_PORT KF_VERACIER_KEYCLOAK

exec "$here/../veracier/stack/stack.sh" "$@"
