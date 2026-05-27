import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { buildExtractTool } from "../tools/investigate-tool.js";
import { searchWebTool } from "../tools/web-tools.js";
import type { AuthContext } from "../workflows/populate.js";
import type { PopulateColumn } from "../../pipeline/populate.js";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
});

function buildOrchestratorInstructions(targetRows: number): string {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.toLocaleString("en-US", { month: "long" });
  const extractCap = Math.max(3, Math.ceil(targetRows / 4));
  const investigateCap = 20;

  return `You fill datasets by searching the web, dispatching extraction agents in parallel, then investigating incomplete rows.

━━ CURRENT DATE ━━
Today is ${currentMonth} ${currentYear} (${now.toISOString().slice(0, 10)}).
Always use this when formulating time-sensitive search queries.

━━ PER-ITERATION FLOW ━━
Each iteration has four phases. Complete all four before starting the next.

PHASE 1 — SEARCH
Run searches in parallel (5 for the first iteration; up to 10 for subsequent ones).
Cover different angles: entity lists, official directories, aggregator sites, specific entity pages.
TIME SENSITIVITY: If the topic mentions "recent", "current", "latest", or a specific year,
include ${currentYear} (or the relevant year) explicitly in every query.
Examples: "YC W2025 batch companies list", "AI startups ${currentYear} funding",
"${currentMonth} ${currentYear} [topic] directory"

PHASE 2 — EXTRACT (parallel, hard cap: ${extractCap} calls per iteration)
Select the best ${extractCap} qualifying URLs from search results AND from leads returned by previous extract_rows calls.
Do NOT dispatch more than ${extractCap} extract_rows calls per iteration — this is a hard limit.
A URL qualifies if ALL of the following are true:
  - Relevance:  title or snippet names a matching entity, list, or directory for this dataset topic
  - Data value: snippet suggests real column values are present (names, prices, dates, contacts, etc.)
  - Source:     official site, known directory, or reputable domain (not SEO spam or thin content)
  - Novelty:    not already dispatched in this run

URL QUALITY — prefer fast, single-page sources:
  PREFER:  editorial lists ("best of", "top N", rankings), Wikipedia list pages, curated directories
           that show all data on ONE page (e.g. en.wikipedia.org/wiki/List_of_...).
  AVOID:   paginated browse/catalog pages — signs: /browse/, /all/, /catalog/, ?page=, ?sort=, ?offset=.
           They are slow and block Phase 3. If you must use one, dispatch page 1 only; the agent
           will return later pages as LEADS.

Track every URL you dispatch — never send the same URL twice in one run.
Emit ALL ${extractCap} extract_rows calls IN A SINGLE RESPONSE (they run in parallel).
Wait for ALL extract_rows calls to finish before moving to Phase 3.

PHASE 3 — REVIEW
Call list_rows exactly once.
Note the complete row count and which rows are INCOMPLETE (shown as INCOMPLETE — missing: ...).

PHASE 4 — INVESTIGATE (parallel, batch of up to ${investigateCap})
From the INCOMPLETE rows in list_rows, select up to ${investigateCap} to investigate this iteration.
Priority: rows with the FEWEST missing columns first (closest to complete → highest impact).
Remaining incomplete rows will be handled in subsequent iterations.

Emit ALL selected investigate_entity calls in a SINGLE response (they run in parallel).
Do NOT call investigate_entity one at a time — all calls for this batch go out simultaneously.
Do NOT call investigate_entity for rows marked COMPLETE.

For each investigate_entity call, include:
  - primary_key: the entity's primary key value
  - missing_columns: the list of blank column names from list_rows
  - context: the row's partial data + any relevant leads/URLs returned by extract_rows

Wait for ALL investigate_entity calls in the batch to finish before starting the next iteration.

━━ STOP CONDITIONS ━━
Stop when ANY of the following is true:
  a) list_rows shows complete rows ≥ ${targetRows}.
  b) 2 consecutive iterations produced NO increase in complete rows.
     After each Phase 3, record the complete row count.
     If it did not increase from the previous iteration, that is one stagnant iteration.
     Two stagnant iterations in a row → stop immediately.

━━ RULES ━━
- Do NOT fetch pages yourself — extract_rows agents fetch pages and write data.
- Do NOT call investigate_entity for COMPLETE rows.
- Use search result titles and snippets to select URLs — do not fetch to evaluate.
- Hard extract cap: ${extractCap} extract_rows calls per iteration maximum. Never exceed this.
- Hard investigate batch: ${investigateCap} investigate_entity calls per batch maximum.`;
}

/**
 * Build the orchestrator Agent for a populate run.
 *
 * Per-iteration flow:
 *   1. Parallel web searches (search_web) — 5 on iteration 1, up to 10 after.
 *   2. extract_rows × ceil(targetRows/4) in parallel — each spawns one extract
 *      agent (maxSteps: 5) that calls fetch_page once and batch_insert_rows once.
 *   3. list_rows — identifies complete vs. incomplete rows.
 *   4. investigate_entity × up to 20 in parallel — prioritises rows with fewest
 *      missing columns; each spawns one investigate agent (maxSteps: 8) that
 *      runs one search round + fetches + update_row_by_key.
 *
 * All writes are inside sub-agents; the orchestrator has no write tools.
 * extract_rows, list_rows, and investigate_entity share the rowIndex closure
 * from buildExtractTool. pendingInserts prevents double-inserts across parallel
 * extract agents without Convex-level changes.
 *
 * A fresh orchestrator is constructed per workflow run; do not cache.
 */
export function buildPopulateAgent(
  authorizedDatasetId: string,
  authContext: AuthContext,
  columns: PopulateColumn[],
  targetRows: number = 20,
): Agent {
  const { extractRowsTool, listRowsTool, investigateEntityTool } = buildExtractTool(
    authorizedDatasetId,
    authContext,
    columns,
    targetRows,
  );

  return new Agent({
    id: "populate-agent",
    name: "Dataset Populate Orchestrator",
    instructions: buildOrchestratorInstructions(targetRows),
    model: openrouter("deepseek/deepseek-v4-pro"),
    tools: {
      search_web: searchWebTool,
      extract_rows: extractRowsTool,
      list_rows: listRowsTool,
      investigate_entity: investigateEntityTool,
    },
  });
}
