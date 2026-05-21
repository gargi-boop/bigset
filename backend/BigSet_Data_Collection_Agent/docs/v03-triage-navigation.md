# v0.3: Source triage + Tinyfish Agent

After fetch, each page is classified before extraction.

## Flow

```
Fetch pages
  → Source Triage Agent (per page)
  → Route by status:
       extract_now              → Extract Agent (markdown)
       requires_navigation      → Agent Goal → Tinyfish Agent → Extract from result
       requires_form_submission   → Agent Goal → Tinyfish Agent → Extract from result
       requires_detail_page_followup → same as navigation
       irrelevant / duplicate / blocked / low_value → skip
  → Merge records
```

## Artifacts

| File | Description |
|------|-------------|
| `triage_initial.json` | Per-page classification (initial pass) |
| `triage_repair.json` | Per-page classification (repair pass) |
| `agent_runs_initial.json` | Tinyfish Agent run log |
| `agent_runs_repair.json` | Repair-pass agent runs |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ENABLE_TRIAGE` | true | Classify pages before extract |
| `ENABLE_TINYFISH_AGENT` | true | Run agent for navigation/form statuses |
| `MAX_AGENT_RUNS_PER_PHASE` | 5 | Cap agent runs per initial/repair pass |
| `AGENT_CONCURRENCY` | 2 | Parallel agent runs |
| `TRIAGE_CONCURRENCY` | 5 | Parallel triage LLM calls |

## CLI

```bash
npm run run -- run --prompt "..." --no-agent    # triage on, agent off (skips navigation pages)
npm run run -- run --prompt "..." --no-triage   # extract all pages (v0.1-style extract)
```

## Status reference

| Status | Action |
|--------|--------|
| `extract_now` | Direct extraction from fetched markdown |
| `requires_navigation` | Tinyfish Agent |
| `requires_form_submission` | Tinyfish Agent |
| `requires_detail_page_followup` | Tinyfish Agent |
| `irrelevant` | Skip |
| `duplicate` | Skip |
| `blocked` | Skip |
| `low_value` | Skip |
