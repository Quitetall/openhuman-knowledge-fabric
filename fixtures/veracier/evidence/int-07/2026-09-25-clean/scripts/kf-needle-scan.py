#!/usr/bin/env python3
"""KF-side persistence audit for S7: do any of the needles (distinctive sentences of the served
text, from a 0600 file never committed) appear in KF's process logs or in the two tables the
context path writes? Prints counts and file names only, never a needle.

  kf-needle-scan.py <needles file> <logs dir> [extra files...]

Positive controls, which must hit (else the scan proves nothing): the corpus text file the record
was ingested from, and search.document.body (KF's lexical index keeps record text by design).
"""
import hashlib, os, stat, subprocess, sys, json
from pathlib import Path

needles_path = Path(sys.argv[1])
assert stat.S_IMODE(needles_path.stat().st_mode) & 0o077 == 0, "needles file must be 0600"
needles = [n for n in needles_path.read_text(encoding="utf-8").splitlines() if n.strip()]
logs = Path(sys.argv[2])
extra = [Path(p) for p in sys.argv[3:]]
out = {"needles_file_sha256": hashlib.sha256(needles_path.read_bytes()).hexdigest(), "needle_count": len(needles),
       "files": {}, "db": {}}

def scan_file(p):
    data = p.read_bytes()
    return sum(1 for n in needles if n.encode() in data)

for p in sorted(logs.glob("*")) + extra:
    if p.is_file():
        out["files"][str(p)] = {"bytes": p.stat().st_size, "needles_found": scan_file(p)}

env = dict(os.environ, PGPASSWORD="dev-only-not-a-secret")
db = "postgres://kf_owner@localhost:15432/kf?sslmode=disable"
queries = {
    "search.context_disclosure (every row, every column as text)": "select count(*) from search.context_disclosure d where position(%s in d::text) > 0",
    "search.recorded_query.query_text (every row)": "select count(*) from search.recorded_query where position(%s in query_text) > 0",
    "search.recorded_query (every row, every column as text)": "select count(*) from search.recorded_query q where position(%s in q::text) > 0",
    "CONTROL search.document.body (KF's lexical index, holds text by design)": "select count(*) from search.document where position(%s in body) > 0",
}
for label, sql in queries.items():
    hits = 0
    for n in needles:
        lit = "$needle$" + n + "$needle$"
        assert "$needle$" not in n
        r = subprocess.run(["psql", db, "-XtAc", sql % lit], env=env, capture_output=True, text=True, check=True)
        hits += int(r.stdout.strip()) > 0
    out["db"][label] = {"needles_found": hits}
rows = subprocess.run(["psql", db, "-XtAc", "select (select count(*) from search.context_disclosure), (select count(*) from search.recorded_query)"],
                      env=env, capture_output=True, text=True, check=True).stdout.strip()
out["db_rows_scanned"] = rows
print(json.dumps(out, indent=2))
