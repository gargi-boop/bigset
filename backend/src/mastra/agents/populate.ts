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

  return `You fill datasets by searching the web, dispatching extraction agents in parallel, then investigating incomplete rows.

━━ CURRENT DATE ━━
Today is ${currentMonth} ${currentYear} (${now.toISOString().slice(0, 10)}).
Always use this when formulating time-sensitive search queries.

━━ PER-ITERATION FLOW ━━
Each iteration has four phases. Complete all four before starting the next.

PHASE 1 — SEARCH
Run searches in parallel (5 for the first iteration; up to 20 for subsequent ones).
Cover different angles: entity lists, official directories, aggregator sites, specific entity pages.
TIME SENSITIVITY: If the topic mentions "recent", "current", "latest", or a specific year,
include ${currentYear} (or the relevant year) explicitly in every query.
Examples: "YC W2025 batch companies list", "AI startups ${currentYear} funding",
"${currentMonth} ${currentYear} [topic] directory"

PHASE 2 — EXTRACT (parallel)
Collect all qualifying URLs from search results AND from leads returned by previous extract_rows calls.
A URL qualifies if ALL of the following are true:
  - Relevance:  title or snippet names a matching entity, list, or directory for this dataset topic
  - Data value: snippet suggests real column values are present (names, prices, dates, contacts, etc.)
  - Source:     official site, known directory, or reputable domain (not SEO spam or thin content)
  - Novelty:    not already dispatched in this run

Track every URL you dispatch — never send the same URL twice in one run.
Avoid batches that clearly cover the exact same set of entities.

Batch qualifying URLs into groups of up to 5 and call extract_rows for each group IN PARALLEL.
Wait for ALL extract_rows calls to finish before moving to Phase 3.

PHASE 3 — REVIEW
Call list_rows exactly once.
Note the complete row count and which rows are INCOMPLETE (shown as INCOMPLETE — missing: ...).

PHASE 4 — INVESTIGATE (parallel)
For every INCOMPLETE row in list_rows, call investigate_entity simultaneously in one response.
Do NOT wait for one investigate_entity to finish before calling the next — they run in parallel.
Do NOT call investigate_entity for rows already marked COMPLETE.

Build the context for each investigate_entity call from:
  - The row's partial data as shown in list_rows
  - Relevant leads and URLs returned by extract_rows in Phase 2

Wait for ALL investigate_entity calls to finish before starting the next iteration.

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
- Do NOT apply a fixed URL count cap — dispatch every URL that passes the quality threshold.`;
}

/**
 * Build the orchestrator Agent for a populate run.
 *
 * The orchestrator coordinates three layers per iteration:
 *   1. Parallel web searches (search_web) to find candidate URLs.
 *   2. Parallel extract_rows calls — each dispatches a batch of 1–5 URLs to a
 *      fresh extract agent that fetches all pages in parallel, extracts all
 *      matching entities, and inserts them via batch_insert_rows in one call.
 *   3. list_rows to identify incomplete rows, then parallel investigate_entity
 *      calls — each spawns an investigate agent that searches the web and fills
 *      missing columns via update_row_by_key.
 *
 * The orchestrator has no write tools of its own — all dataset writes happen
 * inside extract agents (batch_insert_rows) and investigate agents
 * (update_row_by_key), both scoped to the authorized dataset via closure.
 *
 * extract_rows, list_rows, and investigate_entity all share the same in-memory
 * rowIndex closure returned by buildExtractTool. A pendingInserts Set in that
 * same closure prevents parallel extract agents from double-inserting the same
 * entity without requiring Convex-level upsert logic.
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
    model: openrouter("moonshotai/kimi-k2-0905"),
    tools: {
      search_web: searchWebTool,
      extract_rows: extractRowsTool,
      list_rows: listRowsTool,
      investigate_entity: investigateEntityTool,
    },
  });
}
