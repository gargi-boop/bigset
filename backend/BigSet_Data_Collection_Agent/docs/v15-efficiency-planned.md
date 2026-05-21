# v1.5: Efficiency improvements (planned)

**Status:** Design discussed, not implemented. v1.4 behavior remains in production code until this work lands.

v1.5 targets **wall-clock time** and **LLM token cost** without regressing the row quality fixes from [v1.4](v14-ai-sdk-benchmark-and-quality.md).

---

## Proposed themes

### 1. Streaming triage → extract

- On `extract_now`, start extraction as soon as triage completes for that page (do not wait for all triages).
- Prefer **two-call pipeline** over one combined LLM call (keeps routing quality; saves latency).
- Still write `triage_{phase}.json` and extraction artifacts.

### 2. Task-scoped workflow memory

- Replace one `memoryContextForAgents()` blob with **per-role** slices (triage vs extract vs agent-goal vs repair).
- Drop `query_stats.page_breakdown` from agent prompts; pass **domain-scoped** stats where helpful.
- Largest token savings on high page-count phases.

### 3. Outcome-based Tinyfish Agent

- Today: `requires_*` triage → agent queue (no direct extract first).
- Proposed: after direct extract + merge, run agents only if **complete required rows** &lt; target (with triage + cheap-extract gates).
- Requires clearer metrics than raw `records_from_extract` (dedupe collapses many rows).

### 4. Priority-ordered extract and agent queues

- Sort pages by `source_data_confidence`, triage confidence, `domainMemoryBoost`.
- Optional early exit when complete rows ≥ target (with minimum page floor).

### 5. Adaptive agent polling

- Avoid flat **30s** poll interval (adds ~15s average lag per run).
- Proposed: 3s early, backoff to 10–30s, or 30s only for large batches.

---

## Success metrics

Compare v1.4 vs v1.5 on the same `prompts.json` subset:

| Metric | Source |
|--------|--------|
| `duration_ms` | `run_report.json` |
| `llm_usage.total_tokens` | `run_report.json` |
| `visualization_records` / complete count | `run_report.json`, `quality_report.json` |
| Tinyfish agent dispatches | `stats.triage.agent_dispatched` |

Quality must not drop systematically on the 4 “good” benchmark prompts.

---

## References

- Architecture discussion (conversation): efficiency tradeoffs per proposal.
- [data-flow.md](data-flow.md) — current stage contracts unchanged until v1.5 ships.
