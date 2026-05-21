# How search queries and fetch targets are determined

## Search queries

**Code:** `src/agents/dataset-spec.ts` → `generateDatasetSpec()`  
**Prompt:** `DATASET_SPEC_SYSTEM` (system) + user message with `user_prompt` and `output_shape`  
**Execution:** `src/orchestrator/pipeline.ts` runs each string in `spec.search_queries` via `searchWeb()` in `src/integrations/tinyfish.ts`

The LLM is solely responsible for `search_queries`. There is no separate search planner in v0.1.

Each spec request includes `current_date` and `current_year` so time-anchored queries use the present unless the user prompt names a specific period.

## Fetch targets

**Code:** `rankCandidates()` in `src/orchestrator/pipeline.ts`

After Tinyfish Search returns candidates:

1. Deduplicate by normalized URL; score by how often a URL appears across queries (+1 each), plus small boosts for longer title/snippet.
2. Sort by score descending.
3. Keep **one URL per domain**.
4. Take up to `MAX_URLS_TO_FETCH` (default 20).

Tinyfish Fetch receives only those URLs (`src/integrations/tinyfish.ts` → `fetchPages()`).

## Debugging a weak run

1. Open `runs/{id}/dataset_spec.json` — inspect `search_queries`.
2. Open `runs/{id}/source_candidates.json` — see what Search returned per query.
3. Compare `run_report.json` → `fetched_urls` vs candidates.

If queries are poor, fix the Dataset Spec Agent prompt in `dataset-spec.ts` (not fetch ranking).

## v0.2 search-repair loop

After the initial merge, `src/coverage/analyze.ts` checks which **required** columns are still empty.

If gaps exist (and repair is enabled), `src/agents/repair-queries.ts` generates targeted `repair_queries` using:

- missing field names and descriptions
- up to 5 example partial rows
- prior search queries (to avoid duplicates)
- current date/year

The repair pass reuses `src/orchestrator/acquisition.ts` (search → fetch → extract) with:

- URLs already fetched excluded
- lower fetch budget (`MAX_REPAIR_URLS_TO_FETCH`, default 10)
- extraction `focus_fields` set to missing columns

Results merge into existing rows via dedupe keys (`src/merge/records.ts`). One repair iteration per run.
