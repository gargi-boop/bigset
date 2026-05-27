import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { fetchPageTool } from "../tools/web-tools.js";
import type { PopulateColumn } from "../../pipeline/populate.js";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
});

function buildExtractInstructions(
  columns: PopulateColumn[],
  primaryKeyColumn: string,
): string {
  const columnNames = columns.map((c) => c.name);
  const columnsDesc = columns
    .map(
      (c) =>
        `- "${c.name}" (${c.type})${c.description ? `: ${c.description}` : ""}`,
    )
    .join("\n");

  return `You receive a batch of URLs. Fetch all pages in parallel, extract every matching entity, and insert them in one call.

━━ DATASET SCHEMA ━━
Columns:
${columnsDesc}

Primary key column: "${primaryKeyColumn}"
Tool call data/sources keys MUST be exactly: ${JSON.stringify(columnNames)}

━━ STEP 1: FETCH (parallel) ━━
Call fetch_page for ALL URLs simultaneously in a single response.
Wait for ALL fetches to complete before proceeding.

━━ STEP 2: EXTRACT ━━
Read the full content of every successfully fetched page.
Identify ALL entities that match the dataset schema across all pages.
If the same entity appears on multiple pages, prefer the most complete data
(use non-empty values from any page; do not discard data from secondary pages).

━━ STEP 3: BATCH INSERT ━━
Call batch_insert_rows ONCE with ALL entities combined from all pages.
- Include every entity you found — do not omit any.
- For columns you cannot confirm from any page, use "" — never fabricate.
- For every column you DO fill, record the source URL.
- If no matching entities were found on any page, skip this step.

━━ RULES ━━
1. REAL VALUES ONLY. Never fabricate — use "" for unverifiable columns.
2. SOURCE ATTRIBUTION. Record the source URL for every column you fill.
3. READ ALL PAGES FIRST. Identify all entities before calling batch_insert_rows.
4. ONE CALL ONLY. Call batch_insert_rows exactly once with all entities combined.

━━ FINAL OUTPUT ━━
After all work is done, write a summary with exactly these labels:

LEADS: <URLs of other pages you noticed that likely contain more matching entities;
        list each URL on its own line with a dash (- https://...);
        also suggest search queries that might find more entities of this type>
SOURCE_QUALITY: <brief assessment of the pages: data richness, entity coverage, reliability>`;
}

/**
 * Build a fresh extract Agent for one extract_rows call.
 *
 * The agent receives a batch of URLs, fetches all of them in parallel,
 * extracts every matching entity across all pages, and calls batch_insert_rows
 * once with the full combined entity list. It does NOT spawn investigation
 * agents — that is the orchestrator's responsibility after list_rows.
 *
 * Tools: fetch_page, batch_insert_rows.
 * No search capability — it only fetches the URLs provided.
 *
 * batch_insert_rows is passed in from the buildExtractTool closure so the
 * shared rowIndex and pendingInserts are maintained across all agents in one
 * workflow run.
 *
 * A fresh agent instance is constructed per extract_rows call; do not cache.
 */
export function buildExtractAgent(
  columns: PopulateColumn[],
  primaryKeyColumn: string,
  batchInsertRowsTool: ReturnType<typeof import("@mastra/core/tools").createTool>,
): Agent {
  return new Agent({
    id: "extract-agent",
    name: "Dataset Extract Agent",
    instructions: buildExtractInstructions(columns, primaryKeyColumn),
    model: openrouter("moonshotai/kimi-k2-0905"),
    tools: {
      fetch_page: fetchPageTool,
      batch_insert_rows: batchInsertRowsTool,
    },
  });
}
