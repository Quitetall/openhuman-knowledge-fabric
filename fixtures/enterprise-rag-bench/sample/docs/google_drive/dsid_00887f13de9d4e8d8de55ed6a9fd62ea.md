(working notes) Purpose: quick, field-friendly synthesis of recent customer threads (sales demos, CS calls, runtime telemetry) focused on: unexpected latency spikes, token billing confusion, and requests for conservative rollout controls. This doc is intentionally light-weight — use to seed 1–3 micro-probes we can ship in a 2-week sprint.

Executive summary:
- Three signal clusters keep appearing in the last 6 weeks: 1) transient latency spikes on long-chat workloads (esp. >2k tokens), 2) customers misinterpreting token billing for streaming responses, 3) desire for route-level conservative fallbacks when a newer model underperforms.
- Customer impact: mid-market SaaS customers report throttled UX + increased support volume; enterprise prospects flag SLA vs billing clarity as procurement blockers.
- Proposed output: a priority-ordered probe list (low-effort experiments + short comms/UX tweaks) and companion field scripts for CS to test fixes.

Raw customer excerpts (anonymized):
- "We had two chats today that froze for 20s mid-stream — user churned. We’re on dedicated and expected consistent tail latency." — Logistics startup (large convo usage)
- "Why did I get billed for 3 tokens while I was streaming? Our product shows '0/3' but billing went up — confusing for ops." — EdTech platform
- "Rolling the new model caused a degraded reranker on a critical flow. Can we pin fallbacks per route without flipping global settings?" — Search SaaS

Signal details and tentative root causes:
1) Latency spikes (cluster A):
- Pattern: 95th/99th percentile tail spikes tied to conversations that hit long sequence lengths (history accumulation + system prompts).
- Hypothesis: KV cache churn + batching heuristics mismatch — occasional cache eviction + larger recompile paths for long sequences on some GPU kernels.
- Evidence: SRE traces show sudden CPU-bound scheduling events immediately before the RTT spike; trace IDs often include repeated cache-pop misses.
- Customer ask: more predictable tail latency; opt-in conservative execution mode that favors latency SLOs over throughput.

2) Billing confusion for streaming (cluster B):
- Pattern: Customers receiving streaming bytes see billing increments that don’t match UI token counters; most report mismatch only on partial/aborted streams.
- Hypothesis: UI aggregates visible tokens differently from server-side accounting (prefix cached tokens + partial flush semantics). Edge-case when stream aborted mid-token causes double-counting in audit logs.
- Customer ask: clearer breakdown in Console + a quick UI tooltip and sample invoice line explaining streaming billing semantics.

3) Route-level conservative fallbacks (cluster C):
- Pattern: Customers want finer-grained rollout controls (by route/model/tenant) and automatic rollback to a prior model variant if quality or latency regresses.
- Hypothesis: Current rollout tooling is coarse (global or capacity-pool level). Implementing route-level policies requires infra + console changes but could be high leverage for Dedicated/Private customers.
- Customer ask: canary by route, auto-fallback thresholds tied to latency/quality metrics, and safe revert without redeploy.

Prioritized micro-probes (ranked by expected impact / engineering effort):
A. Tail-latency conservative execution flag (MVP)
- What: Add per-route boolean flag (runtime) to prefer smaller batches + keep KV cache reservation for long conversations -> reduces cache churn.
- Why: Low-risk toggle, can be per-route for Dedicated and Private customers; expected to reduce 99th percentile spikes.
- Rough effort: 3–7 dev days (runtime + small console checkbox), need QA on throughput regressions.
- CS play: enable for 3 pilot accounts, collect latency before/after for 48h windows.

B. Streaming billing explainer + invoice sample (quick win)
- What: Console tooltip + billing doc page showing examples: streaming aborted cases, prefix-cached tokens, and sample invoice lines. Embedded FAQ snippet for sales/procurement.
- Why: Low effort and immediate deflation of support tickets and procurement friction.
- Rough effort: 1–2 product dev days + doc + a short email template for CS.
- CS play: push to top-20 customers that have raised billing tickets in last 3 months.

C. Route-level canary + auto-fallback sketch (spike)
- What: Design doc + small prototype for routing rules: route -> model variants with thresholded rollback triggers (latency > X ms or quality drop by Y points). Rollout API and console UI mock.
- Why: Medium-high effort but high strategic value (enterprise/Dedicated sales blocker).
- Rough effort: design 2–3 weeks, prototype 2–4 sprints depending on infra dependencies.

D. 'Abort-safe streaming' auditing change (engineering)
- What: Fix server-side accounting for partially-processed tokens when streaming aborts mid-token; add an 'abort reason' tag in billing logs so CS can reconcile quickly.
- Why: Fixes root cause of double-counting.
- Rough effort: 3–6 dev days across billing + runtime teams. Add unit tests for abort paths.

Risk map / unknowns:
- Conservative exec flag might increase cost per token / reduce throughput — need to quantify for high-throughput customers. Will require clear docs and opt-in path.
- Private installations: KV cache behaviors vary across hardware/quantization; pilot on representative on-prem customer before broad rollout.
- Billing logs change requires finance review — compute impact on downstream invoicing, reports.

Implementation checklist (starter):
- A1: Draft runtime toggle (flag + annotation in traces) and expose via API -> bring to eng-serving-runtime standup. Owner: @eng: runtime
- A2: CS pilot candidate list (3 customers with reproducible spikes). Owner: Marco + Priya. Timeline: 1 week to seed pilots.
- B1: Billing explainer draft + invoice examples (attach to billing-FAQ). Owner: Liam. Timeline: 3 business days.
- C1: Route-canary design doc skeleton (mock console screens + API sketch). Owner: Product-hosted-api + Solutions-eng. Timeline: kickoff next sprint.
- D1: Billing abort audit fix PR -> link to review (see linked_artifacts). Owner: eng-billing. Timeline: 2 sprints for full QA.

Metrics to collect during pilot:
- 50/90/99 percentile latency pre/post per route
- Token-per-request cost delta (for conservative execution flag)
- Number of billing mismatch tickets in 7/30 days post-explainer
- Auto-fallback false-positive rate during canary prototype

Field script for CS (to run on pilot accounts):
- Step 0: verify current baseline: capture 24h of traces (attach to ticket), record 50/90/99 p95/p99
- Step 1: enable conservative flag on a single non-critical route, run for 48h, monitor per-minute tail latency, token throughput, and errors
- Step 2: reproduce streaming abort scenario with short test harness to confirm billing logs correlate; capture logs and invoice snippet
- Step 3: attempt manual model swap to sim failure and verify fallback semantics (manual revert)
- Notes: take screenshots for Console, and collect product/engineering logs; flag any cost spikes immediately.

Notes-to-self / open questions:
- Can we surface 'expected cost delta' when the conservative flag is toggled in Console? If yes, that will smooth sales conversations.
- What is the simplest telemetry signal for model-quality regression suited to auto-fallback? (BLEU-like signal is fragile; maybe use client-provided eval prompts.)
- Resourcing: need SRE time for pilot monitoring dashboards — loop in observability (Yuna).

Appendix: quick mapping of related tickets and prior notes:
- KV cache heuristics spike: Linear INF-987 (linked)
- Billing abort double-count: GH runtime PR/4023 (linked)
- Rollouts/route policies: CONFLUENCE-PLATFORM-1209 (linked)

If you read one thing: enable B (billing explainer) now — quick returns on CS volume + procurement friction. Next biggest leverage is A (conservative exec flag) as a tactical opt-in while we scope C.

-- end working draft --

(bootstrap checklist: convert to ticket for product+runtime; share with Solutions Eng next Tues; capture pilot customers in a shared spreadsheet)