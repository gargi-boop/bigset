# v1.1: Workflow memory & multi-repair loops

v1.1 adds **central workflow memory** and **multiple repair loops** with a diagnosis step between each loop.

Repair **search budgeting** (curated queries vs pagination + link-follow) is documented in **[v12-follow-up-repair.md](v12-follow-up-repair.md)** (v1.2).

## Workflow memory

Stored per run at `runs/{run_id}/workflow_memory.json` and persisted across runs at `memory/{prompt_fingerprint}.json` (same user prompt → same fingerprint).

| Field | Purpose |
|-------|---------|
| `query_stats` | Per search query: URLs produced, URLs with records, record count, **avg_completeness**, **avg_confidence**, **search_page** (last page used), **weighted_quality** (front-page–biased), **page_breakdown** per Search API page |
| `domain_stats` | Per hostname: record count, fetch failures, **avg_completeness**, **avg_confidence** |
| `agent_goal_stats` | Per agent goal: record count, **avg_completeness**, **avg_confidence** from rows on that URL |
| `extraction_schema` | Column snapshot + dedupe keys |
| `dedupe_keys` | Merge identity fields |
| `repair_loop_count` | Loops completed this run |
| `diagnoses` | Per-loop repair diagnosis (LLM) |
| `strategy_notes` | Summaries from diagnoses |
| `last_missing_fields` | Required columns still gap-filled |

Injected into agents as `query_stats_top` / `query_stats_weak`, `domain_stats_top` / `domain_stats_weak`, `agent_goal_stats_top` (sorted by quality scores).

Memory is injected into: Dataset Spec (prior run), Source Triage, Extract, Agent Goal, Repair Diagnosis, Repair Queries.

## Multi-repair loop

1. Initial acquisition → merge → coverage  
2. While `coverage.should_repair` and `repair_loop_count < MAX_REPAIR_LOOPS`:
   - **Repair Diagnosis Agent** — why gaps remain, which domains/queries to try/avoid, whether to prefer agent  
   - **Repair Queries Agent** — new searches using memory + diagnosis  
   - Acquisition: new queries at Search page `0`; top historical queries re-run at page `1`, `2`, … (see [Search API](https://docs.tinyfish.ai/search-api/reference)); optional outbound [link follow](https://docs.tinyfish.ai/fetch-api/reference) from high-value pages  
   - Domain ranking uses memory; may force agent if diagnosis says so  
   - Merge into existing rows → coverage  

Artifacts per loop: `repair_diagnosis_{n}.json`, `repair_queries_{n}.json`, `coverage_repair_{n}.json`.

## Configuration

```env
MAX_REPAIR_LOOPS=3
ENABLE_WORKFLOW_MEMORY=true
MAX_REPAIR_SEARCH_PAGINATION_QUERIES=2
ENABLE_REPAIR_LINK_FOLLOW=true
MAX_REPAIR_LINK_URLS=8
```

Disable memory: `ENABLE_WORKFLOW_MEMORY=false`. Disable all repair: `ENABLE_REPAIR_LOOP=false` or `--no-repair`.

## Recurring runs

Re-run the same prompt; the pipeline loads `memory/{fingerprint}.json` and passes prior successful queries/domains into the Dataset Spec and repair agents so later runs avoid repeating failed patterns.
