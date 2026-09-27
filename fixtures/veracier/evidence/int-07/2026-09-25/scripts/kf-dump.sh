#!/usr/bin/env bash
# KF-side dump for one scenario window: search.context_disclosure rows (no text column exists) with
# the served record's current classification, and search.recorded_query ids only (never query_text).
#   kf-dump.sh <start timestamptz> <end timestamptz> <out file>
set -euo pipefail
start="$1"; end="$2"; out="$3"
export PGPASSWORD='dev-only-not-a-secret'   # the fixture's public development credential (docker-compose.yml)
db='postgres://kf_owner@localhost:15432/kf?sslmode=disable'
{
  echo "# window: $start .. $end"
  echo "## search.context_disclosure"
  psql "$db" -X -v ON_ERROR_STOP=1 --csv -c "
    select d.id, d.recorded_at, d.operation, d.refusal, d.object_id, o.classification as object_classification,
           d.revision, d.text_digest, d.references_digest, d.reference_count, d.omitted_count,
           d.agent_participation, d.asker_rank, encode(d.asker_key, 'hex') as asker_key, d.corpus_digest, d.expires_at
      from search.context_disclosure d left join core.object o on o.id = d.object_id
     where d.recorded_at >= '$start'::timestamptz and d.recorded_at <= '$end'::timestamptz
     order by d.recorded_at"
  echo "## search.recorded_query (ids only; query_text deliberately not selected)"
  psql "$db" -X -v ON_ERROR_STOP=1 --csv -c "
    select id, recorded_at, asker_ceiling, asker_rank, encode(asker_key, 'hex') as asker_key, expires_at
      from search.recorded_query
     where recorded_at >= '$start'::timestamptz and recorded_at <= '$end'::timestamptz
     order by recorded_at"
} > "$out"
