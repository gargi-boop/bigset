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

  return `You receive exactly ONE URL. Your entire job fits in 2 tool calls.

━━ HARD BUDGET ━━
Tool call 1: fetch_page — call it ONCE for the URL in your prompt.
Tool call 2: batch_insert_rows — call it ONCE with every entity you found.
That's it. 2 tool calls total. Do not make any other tool calls.

━━ STRICT CONSTRAINTS ━━
- Do NOT call fetch_page more than once. No pagination. No following links.
  If the page is paginated, extract only what is on the first response.
  Add the other page URLs (e.g. ?page=2) to LEADS — do not fetch them yourself.
- Do NOT call batch_insert_rows more than once.
- If no matching entities were found, skip batch_insert_rows entirely and go straight to FINAL OUTPUT.

━━ DATASET SCHEMA ━━
Columns:
${columnsDesc}

Primary key column: "${primaryKeyColumn}"
Tool call data/sources keys MUST be exactly: ${JSON.stringify(columnNames)}

━━ PROCEDURE ━━
1. Call fetch_page for the URL in your prompt. (tool call 1)
2. Read the content. Extract every entity that matches the schema.
   - Use "" for any column you cannot confirm from this page. Never fabricate.
   - Record the page URL as source for every column you fill.
3. Call batch_insert_rows with all entities in one call. (tool call 2)
4. Write FINAL OUTPUT.

━━ FINAL OUTPUT ━━
After all tool calls are done, write a summary with exactly these labels:

LEADS: <list each URL on its own line with a dash (- https://...);
        include pagination URLs you did NOT fetch, related list pages you noticed,
        and search queries that would find more entities of this type>
SOURCE_QUALITY: <brief assessment: data richness, entity coverage, reliability>`;
}

/**
 * Build a fresh extract Agent for one extract_rows call.
 *
 * The agent receives one URL, fetches the page, extracts every matching
 * entity, and calls batch_insert_rows once with the full entity list.
 * It does NOT spawn investigation agents — that is the orchestrator's
 * responsibility after list_rows.
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
    model: openrouter("deepseek/deepseek-v4-pro"),
    tools: {
      fetch_page: fetchPageTool,
      batch_insert_rows: batchInsertRowsTool,
    },
  });
}
