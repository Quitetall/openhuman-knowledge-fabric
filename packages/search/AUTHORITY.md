# @kf/search

Search over canonical records, with access control applied before results are returned.

Authority: none. Indexes are disposable and must be rebuildable from authoritative records
(§2.10).

## One fused list, and the two it was fused from (§64A, KF-SAS-RQ-224)

`composeSearch` answers one query with one list to read first and the two rankings it came from:

- **ranked** — the lexical page and the re-checked semantic list fused by reciprocal rank fusion
  with its published constant (k = 60; Cormack, Clarke and Büttcher, 2009), each word match's vote
  weighted by how far its share of the query lies above the lexical floor, (coverage − 0.5) / 0.5,
  and a partial-identifier match voting 1 — named
  `kf.fused.rrf.v2(k=60; lexical vote=(coverage-0.5)/0.5; <lexical>; <semantic>)` (SAS §100.45;
  `v1` gave every word match a full vote, and the fused list fell below the semantic list alone on
  Véracier and TheAgentCompany). Every fused hit says where each ranking placed it (`lexical.rank`
  and how it matched, `semantic.rank`). Fusion adds no record and uses nothing but the two lists'
  places and the lexical ranking's own score, so a semantic hit reaches it only after the re-check
  below. Without a semantic list the fused list is the lexical page in its own order, and its name
  says so.
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

## How the lexical vote was chosen, and what it costs (SAS §100.45)

Nothing was fitted to the evaluation questions. Every question of the four fixture corpora was put
in one of two halves by the parity of the first byte of sha256(`<corpus>:<question id>`). The
candidates were scored offline from each question's served lexical page and semantic list (fusion
is a function of the two, so this is exactly what the API serves): plain RRF; a vote equal to the
coverage; the vote above the floor; and a mixture `α + (1 − α)·vote` with α fitted. The rule,
stated before the held-out half was read: maximise, on the first half, the worst margin over the
eight corpus × query-form cells of the fused list over the better of its two sources. The vote
above the floor won it on the first half (worst margin −0.044; plain RRF −0.142; the best fitted
mixture, α = 0.25, −0.050) and on the held-out half (−0.083; plain RRF −0.417; α = 0.25, −0.125).

It wins on no corpus everywhere. Recall@10 over all questions, plain RRF → this vote, on the same
stack: Véracier 0.1603 → 0.1890 and 0.1855 → 0.2070 (semantic 0.1866, 0.2020); TheAgentCompany
0.5265 → 0.8182 and 0.2917 → 0.4583 (semantic 0.8182, 0.5038 — the keyword form is still below
it); DRBench 0.7887 → 0.7606 and 0.7977 → 0.7855; EnterpriseRAG-Bench 0.8083 → 0.7216 and
0.7236 → 0.6170, where its keyword form falls below the lexical list alone (0.6640). Where word
matches are strong, plain RRF used them better; this vote trades that for not letting weak ones
displace the semantic list. The four reports carry the served numbers.

Also measured, not adopted: BM25 (k1 = 1.2, b = 0.75, its published defaults) as the lexical leg
of the fusion. On TheAgentCompany it found the named files the coverage floor never matches
(lexical recall 0.02 → 0.32, fused 0.53 → 0.65), still below the semantic list; computed over
`search.document`'s vectors it took about two seconds a question on 1 277 records and was not
practical on the 50 000 of EnterpriseRAG-Bench without term statistics this schema does not keep.

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
