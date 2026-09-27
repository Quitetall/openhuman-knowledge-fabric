#!/usr/bin/env python3
"""Delta S7 KF-side persistence audit. Two kinds of needle, from 0600 files outside the repository:

  source needles  distinctive sentences of the served control text;
  query needles   the query strings the runs sent to KF.

For each: KF's process logs, the fixture containers' logs, and every row of
search.context_disclosure, search.identification_refusal and search.recorded_query (all columns as
text). Only counts are printed, never a needle. The declared, owner-accepted exception is query
text in search.recorded_query.query_text (90 days), which is reported, not failed. Positive
controls must hit: the corpus file (source) and search.document.body (source; the lexical index
keeps text by design); for query needles, recorded_query.query_text is itself the control.

  kf-persistence-scan.py <source needles> <query needles> <logs dir> <corpus file>
"""
import hashlib, json, os, stat, subprocess, sys
from pathlib import Path

def private(p):
    p = Path(p); assert stat.S_IMODE(p.stat().st_mode) & 0o077 == 0, f"{p} must be 0600"
    return [l for l in p.read_text(encoding="utf-8").splitlines() if l.strip()], hashlib.sha256(p.read_bytes()).hexdigest()

src, src_sha = private(sys.argv[1]); qry, qry_sha = private(sys.argv[2])
logs, corpus = Path(sys.argv[3]), Path(sys.argv[4])
env = dict(os.environ, PGPASSWORD="dev-only-not-a-secret")
db = "postgres://kf_owner@localhost:15432/kf?sslmode=disable"
def sql(q): return subprocess.run(["psql", db, "-XtAc", q], env=env, capture_output=True, text=True, check=True).stdout.strip()
def lit(n):
    assert "$n$" not in n; return "$n$" + n + "$n$"
tables = {
    "search.context_disclosure (all columns)": "select count(*) from search.context_disclosure t where position({} in t::text) > 0",
    "search.identification_refusal (all columns)": "select count(*) from search.identification_refusal t where position({} in t::text) > 0",
    "search.recorded_query columns other than query_text": "select count(*) from search.recorded_query t where position({} in concat_ws('|', t.id, t.organization_id, t.asker_ceiling, t.asker_rank, encode(t.asker_key,'hex'), t.recorded_at, t.expires_at)) > 0",
    "DECLARED search.recorded_query.query_text (owner-accepted 90-day retention)": "select count(*) from search.recorded_query where position({} in query_text) > 0",
    "CONTROL search.document.body (lexical index)": "select count(*) from search.document where position({} in body) > 0",
}
containers = {}
for c in ("kf-veracier-postgres", "kf-veracier-keycloak", "kf-veracier-minio"):
    r = subprocess.run(["docker", "logs", c], capture_output=True)
    containers[c] = r.stdout + r.stderr
out = {"source_needles_sha256": src_sha, "source_needle_count": len(src),
       "query_needles_sha256": qry_sha, "query_needle_count": len(qry),
       "rows": {t: sql(f"select count(*) from {t}") for t in ("search.context_disclosure", "search.identification_refusal", "search.recorded_query")},
       "scan": {}}
for kind, needles in (("source", src), ("query", qry)):
    res = {}
    for p in sorted(logs.glob("*")):
        if p.is_file():
            d = p.read_bytes(); res[f"file {p}"] = sum(n.encode() in d for n in needles)
    for c, d in containers.items():
        res[f"container log {c}"] = sum(n.encode() in d for n in needles)
    if kind == "source":
        d = corpus.read_bytes(); res[f"CONTROL file {corpus}"] = sum(n.encode() in d for n in needles)
    for label, q in tables.items():
        if kind == "query" and label.startswith("CONTROL"): continue
        res[label] = sum(int(sql(q.format(lit(n)))) > 0 for n in needles)
    out["scan"][kind] = res
print(json.dumps(out, indent=2))
