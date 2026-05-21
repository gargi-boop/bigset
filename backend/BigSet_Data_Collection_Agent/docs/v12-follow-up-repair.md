# v1.2: Follow-up repair (pagination + outbound links)

v1.2 extends repair acquisition so each loop can **deepen discovery** beyond the curated repair queries produced by the LLM:

1. **Search pagination** — re-run historically strong query strings on the Tinyfish Search API at the **next page** (`last_page_used + 1`), up to a small cap ([Search API pagination](https://docs.tinyfish.ai/search-api/reference)).
2. **Outbound link follow** — after fetching top-ranked URLs, optionally request `links: true` from Fetch and heuristic-select a few outbound URLs for a **second Fetch pass** ([Fetch links](https://docs.tinyfish.ai/fetch-api/reference)).

Baseline **v1.1 repair** remains: diagnosis → curated repair queries → search → fetch → triage/extract/agent → merge. See [v11-workflow-memory.md](v11-workflow-memory.md) for workflow memory fields.

---

## Defaults (from `.env` / config)

| Variable | Default | Role |
|---------|---------|------|
| `MAX_REPAIR_QUERIES` | 4 | Max **curated** repair search strings **per repair loop** (LLM-generated; each searched at Search **page 0**) |
| `MAX_REPAIR_SEARCH_PAGINATION_QUERIES` | 2 | Max **pagination follow-up searches** appended per repair loop (same query text as top memory rows; page = `last_used + 1`, capped by `MAX_SEARCH_PAGE`) |
| `MAX_SEARCH_PAGE` | 10 | Hard cap for Search API `page` (API allows up to page 10) |
| `MAX_REPAIR_RESULTS_PER_QUERY` | 5 | Hits kept per Search call |
| `MAX_REPAIR_URLS_TO_FETCH` | 10 | Max **primary** fetch URLs ranked from the **combined** search result pool for that repair phase |
| `ENABLE_REPAIR_LINK_FOLLOW` | true | Secondary fetch wave from outbound links |
| `MAX_REPAIR_LINK_URLS` | 8 | Max extra URLs fetched from link-follow (heuristic-ranked) |
| `MAX_LINKS_PER_SOURCE_PAGE` | 3 | Max links pulled per fetched page toward that cap |

Artifacts: `repair_queries_{n}.json` includes **`repair_searches`**: `{ query, page }` for every Tinyfish Search invocation in that loop. Loop logs show `X searches (Y new, Z paginated)`.

---

## Counts per repair loop: curated vs follow-up searches

Treat **repair queries** here as Tinyfish Search API calls executed during that loop’s acquisition.

### Curated searches (fresh LLM plan)

- **At most `MAX_REPAIR_QUERIES`** (default **4**).
- Each runs at **`page = 0`** after deduplicating empty duplicates.
- The Repair Queries Agent **writes a new list every loop** (informed by memory and diagnosis). The pipeline **does not** automatically replay `/repair_queries_(n−1)` strings—the prior loop text is visible to the model via `priorSearchQueries`, but replay is **optional** depending on LLM output.

### Pagination follow-up searches

- **Up to `MAX_REPAIR_SEARCH_PAGINATION_QUERIES`** (default **2**).
- Chosen by **rollup** of `query_stats` across the run memory: top queries by **`weighted_quality`**, skipping any query **already planned** by the curated list (same string ⇒ one Search only).
- For each eligible query text, Tinyfish Search runs at **`next_page`** where:

  **`next_page = max(search_page in memory rollup) + 1`**, then clamped **`≤ MAX_SEARCH_PAGE`**.

- So **repair loop 1** may add **pagination 0**, **1**, or **2** searches depending on whether any query strings already have `record_count > 0` aggregated from earlier phases (**initial acquisition** fills memory before the first repair iteration). Purely cold edge cases yield **zero** pagination searches.

### Combined total Tinyfish searches in one repair loop

Let **C** = unique curated searches (≤ `MAX_REPAIR_QUERIES`) and **P** = pagination adds (≤ `MAX_REPAIR_SEARCH_PAGINATION_QUERIES`, minus dedupe with **C**, minus queries already at API page cap).

**Tinyfish Search calls:** **C + P** (typically **≤ 6** with defaults: 4 + 2).

Example with defaults:

| Loop | Curated searches (page 0) | Pagination searches (pages 1, 2, …) |
|------|---------------------------|--------------------------------------|
| 1 | ≤ 4 | ≤ 2 (often 0–2 once memory attributes rows) |
| 2 | ≤ 4 (new LLM strings) | ≤ 2 (next pages for strongest historical queries; may reuse same query text at higher `page`) |
| 3 | ≤ 4 | ≤ 2 |

---

## Extractions (fetch + triage + extract/agent)

Repair does **not** maintain separate extraction budgets for “curated hits” versus “pagination hits.”

### Primary fetch tier

All Search results (**curated + pagination**) merge into **`SourceCandidate`** list. Ranking picks up to **`MAX_REPAIR_URLS_TO_FETCH`** (default **10**) distinct domains/URLs → Fetch → usual triage / extract / agent path. Extractions attributed to whichever query surfaced the URL (**`search_page`** on candidates).

So **many primary extractions originate from curated searches** whenever those results rank highest; pagination adds more candidates **only if** they score into the same top‑N URL budget without duplicating URLs already fetched this run (**`excludeUrls`**).

### Secondary fetch tier (links)

If **`ENABLE_REPAIR_LINK_FOLLOW`**, Fetch uses **`links: true`** on the primary batch when enabled in code path. Selected outbound links (URL-only heuristic, plus domain memory boosts) enqueue up to **`MAX_REPAIR_LINK_URLS`** (default **8**) **additional Fetch calls** → same triage/extract/agent pipeline—**no** extra Tinyfish Search queries.

---

## “Same as previous repair queries?”

Two different ideas:

| Idea | Supported? |
|------|------------|
| **Automatically re-run verbatim `repair_queries` from repair loop \(n−1\)** | **No** fixed replay; the Repair Queries Agent may voluntarily repeat wording because it receives `priorSearchQueries`. |
| **Reuse query *text that worked before*** (possibly from initial or older repairs) **at deeper Search pages** | **Yes** — **pagination follow-up**, independent of yesterday’s curated list. |

Pagination is keyed on **successful query strings in memory**, not on “equality with last loop’s curated JSON.”

---

## Relation to recurring runs (`memory/`)

Cross-run `memory/{fingerprint}.json` restores **query/domain stats**. Pagination chooses top queries **after merging** persisted memory (see workflow memory merge behavior in v1.1 docs), so recurring runs **start with non-zero rollup** sooner.

---

## Version bump

CLI and **`package.json`** report **v1.2**. Quality (v1.0) and workflow memory scaffolding (v1.1) are unchanged besides new memory fields consumed by pagination ranking.
