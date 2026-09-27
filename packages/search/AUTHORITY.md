# @kf/search

Search over canonical records, with access control applied before results are returned.

Authority: none. Indexes are disposable and must be rebuildable from authoritative records
(§2.10).

## One fused list, and the two it was fused from (§64A, KF-SAS-RQ-224)

`composeSearch` answers one query with one list to read first and the two rankings it came from:

- **ranked** — the lexical page and the re-checked semantic list fused by reciprocal rank fusion
  with its published constant (k = 60; Cormack, Clarke and Büttcher, 2009), named
  `kf.fused.rrf.v1(k=60; <lexical>; <semantic>)`. Every fused hit says where each ranking placed it
  (`lexical.rank` and how it matched, `semantic.rank`). Fusion adds no record and uses nothing but
  the two lists' places, so a semantic hit reaches it only after the re-check below. Without a
  semantic list the fused list is the lexical page, and its name says so.
- **lexical** — word matching over `search.document` (`search.lexical_matches`, 20260926100000),
  ranking named `kf.lexical.idf_coverage(floor=0.5)+phrase+partial_identifier.v2`. A record
  matches when it holds at least half of the query's information: the inverse document frequency
  of the query terms it contains over that of all terms. Not every word is required; the records
  holding every word, and then the phrase as typed, rank first. Each record is indexed in its own
  detected language(s) and each query term is matched through every supported language's stem of
  it. Exhaustive within its scope: `total` is the number of granted matches, and `complete` says
  whether the page holds all of them.
- **semantic** — the retrieval engine's ranking, under the name the engine gives it, present only
  when the engine answered. Every id is re-read through `search.document` and `core.object` under
  the caller's row security in one statement, then through the caller's grants. An id that fails
  either refuses the whole semantic list, because it means the engine's mask was wrong, and a
  shortened list reads as a complete one.

When no engine is configured, or the engine cannot serve, the lexical list is still served and
the withholding ledger carries `semantic_ranking_unavailable` with its reason (KF-SAS-RQ-216).

**Near misses** (KF-SAS-RQ-217) are returned only when asked for, as a separate
`nearMisses { label, scoringFunction, hits }`. The engine ranks `2k`; the first `k` are the answer
and the rest are offered as adjacent, and the scoring function's name says exactly that. They are
re-checked like every semantic hit. The withholding ledger does not count them.

**What was withheld** (KF-SAS-RQ-222, ADR 0037) is one number, `withheldCount`: records at or
below the asker's ceiling that match the lexical query and that no grant reaches. It is computed on
every request and stored nowhere. Records above the ceiling are invisible to the query under row
security, so they are never counted, and nothing about a withheld record except the count is
returned. A masked record is never scored by the engine, so the count is over lexical matches, under
the same floor that decides what the lexical list holds.

## Transient observations (§64B)

A query is a transient observation, not a record (ADR 0029). `recordQuery` writes
`search.recorded_query` through a definer seam: the text, the organization, the asker's ceiling and
a pseudonymous asker key — an HMAC of the person under a key in `search.asker_key`, which no
application role can read and which rotates with the window — and never the person. Rows expire
after 90 days and `core.sweep_transient_observations()` deletes them. The same holds for
`search.demand_contribution` and for `retrieval.disclosure`, which records the digest of each
engine trace (KF-SAS-RQ-219) and has no person column.

`replayRecordedQuery` runs a recorded query at the replayer's ceiling and grants, returns the
records the original asker's ceiling withheld — computed, not stored — and counts each once per
distinct asker key into the durable `org.access_demand` aggregate: a record and a count of distinct
persons, never which persons (KF-SAS-RQ-221). A person whose key rotated between two replays is
counted twice, so the count can overstate distinct people across a rotation; and a quiet report is
not evidence of no unmet demand (§100.23).

**A person's own recorded queries** (KF-SAS-RQ-221). `GET /search/recorded-queries` lists the
caller's own recorded queries and nobody else's: `search.my_recorded_queries()` recomputes the
bound principal's asker key under every live pseudonym key and returns the rows carrying it, so the
application still never reads a key or an asker column, and there is no argument naming whose
queries to list. `POST /search/recorded-queries/:id/replay` replays one of them through
`replayRecordedQuery` — at the caller's ceiling now, which may be higher than the ceiling the
query ran at — and so counts into `org.access_demand`. A replay of a query that is not the
caller's own is answered as not found, exactly like an expired one; replaying other people's
queries, which ADR 0029 envisages for somebody cleared higher, needs a listing of them and is not
offered here. The web page is `/search/recorded`.
