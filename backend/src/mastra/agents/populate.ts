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

  return `You fill datasets by searching the web and dispatching prioritized URLs to extraction agents.

━━ CURRENT DATE ━━
Today is ${currentMonth} ${currentYear} (${now.toISOString().slice(0, 10)}).
Always use this when formulating time-sensitive search queries.

━━ SEARCH QUERY RULES ━━
- Cover different angles: entity lists, official directories, aggregator sites, specific entity pages.
- TIME SENSITIVITY: If the dataset topic mentions "recent", "current", "latest", "this year",
  or a specific year, always include the relevant year or month explicitly in every query.
  Use ${currentYear} as "current year" — do NOT default to older years from your training data.
  Examples: "YC W2025 batch companies list", "AI startups ${currentYear} funding",
  "${currentMonth} ${currentYear} [topic] directory"

━━ URL SELECTION CRITERIA ━━
After each search round, evaluate results using these signals:
- title:     Names a list, directory, or specific entity matching the dataset?
- snippet:   Mentions real column values (prices, contacts, dates, categories)?
- url:       Official site, authoritative directory, or known reputable domain?
- diversity: Choose URLs from DIFFERENT domains — avoid clustering on the same site.

━━ 1. FIRST BATCH ━━
Run exactly 5 searches in parallel. Wait for ALL results.
Select the TOP 5 most valuable URLs from the results.
Dispatch these 5 as 5 SEPARATE extract_rows calls in parallel — exactly 1 URL per call.
Wait for ALL 5 to complete, then call list_rows to check progress.

━━ 2. SECOND BATCH ━━
Using leads returned by the first batch plus new search angles, run up to 20 searches in parallel.
Wait for ALL results.
Select the TOP 10 most valuable URLs not yet dispatched.
Dispatch as up to 10 parallel extract_rows calls. Wait for ALL, then call list_rows.

━━ 3. SUBSEQUENT BATCHES ━━
Repeat the second-batch pattern for each additional round:
  a. Run up to 20 searches combining leads from the previous batch with new angles.
  b. Select up to 10 most valuable un-dispatched URLs.
  c. Dispatch as parallel extract_rows calls. Wait for ALL, then call list_rows.

Leads from extract_rows: Each result returns a "leads" field with natural language descriptions
  of other pages and entities discovered. Read these carefully and extract specific URLs to dispatch.

DEDUPLICATION: Track every URL you dispatch to extract_rows. Never send the same URL twice
in one run, even if it appears in multiple leads or search results.

━━ 5. STOP CONDITIONS ━━
Stop when ANY of the following is true:
  a) list_rows shows complete rows ≥ ${targetRows}.
  b) 2 consecutive batches produced NO increase in complete rows per list_rows.
     — "batch" means one parallel round of extract_rows calls, waited for together.
     — Track explicitly: after each batch, record the complete row count from list_rows.
       If it did not increase from the previous batch, that is one stagnant batch.
       Two stagnant batches in a row → stop immediately.

Do NOT fetch pages yourself — only extract_rows agents fetch pages and write data.
Use search result titles, snippets, and URLs to make all prioritization decisions.`;
}

/**
 * Build the orchestrator Agent for a populate run.
 *
 * The orchestrator searches only — it has no fetch or write tools.
 * All page fetching, entity extraction, and row insertions happen inside
 * triage-extract subagents (via extract_rows), which in turn spawn
 * investigate subagents for rows with missing columns.
 *
 * Both extract_rows and list_rows share the same in-memory rowIndex closure
 * returned by buildExtractTool, making list_rows an accurate real-time
 * view of dataset state without a Convex round-trip.
 *
 * A fresh orchestrator is constructed per workflow run; do not cache.
 */
export function buildPopulateAgent(
  authorizedDatasetId: string,
  authContext: AuthContext,
  columns: PopulateColumn[],
  targetRows: number = Number(process.env.BIGSET_POPULATE_TARGET_ROWS || "20"),
): Agent {
  const { extractRowsTool, listRowsTool } = buildExtractTool(
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
    },
  });
}
