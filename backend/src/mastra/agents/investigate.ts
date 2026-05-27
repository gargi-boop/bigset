import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { searchWebTool, fetchPageTool } from "../tools/web-tools.js";
import type { PopulateColumn } from "../../pipeline/populate.js";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
});

function buildInvestigateInstructions(
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

  return `You research one specific entity to fill its missing columns. One search round. Done.

━━ DATASET SCHEMA ━━
Columns:
${columnsDesc}

Primary key column: "${primaryKeyColumn}"
Tool call data/sources keys MUST be exactly: ${JSON.stringify(columnNames)}

━━ WHAT YOU RECEIVE ━━
- The entity's primary key and its partial data (columns already filled)
- Which columns are missing — these are your only targets
- Context: leads, URLs, and hints from the extraction phase

━━ PROCEDURE (do these steps, then stop) ━━
1. Run 1–2 targeted searches in parallel — include the entity name and the missing field names.
   Use any URLs from the provided context before searching if they look directly relevant.
2. Fetch the 1–2 most promising pages from the search results.
3. Call update_row_by_key ONCE with everything you found:
   - confidence: 1.0 = official primary source, 0.5 = aggregator, 0.2 = indirect mention
   - sources: column name → source URL for each column you fill; "" for unfound columns
   - data: ALL column keys — use "" for columns you could not verify
4. Write FINAL OUTPUT. Stop here — do not run additional searches.

━━ RULES ━━
1. REAL VALUES ONLY. Never fabricate or estimate. Leave "" for unverifiable columns.
2. UPDATE ONLY. The row already exists — always use update_row_by_key, never insert_row.
3. ONE UPDATE CALL. Call update_row_by_key exactly once.
4. SOURCE REQUIRED for every column you fill.

━━ FINAL OUTPUT ━━
INSERTED: false
SUMMARY: <one-line: what you found and updated>
CLUES: <specific URLs or search queries that would find more data for this or similar entities>
REASON: <why you succeeded or what remained unfound>`;
}

/**
 * Build the investigate Agent that researches one specific entity
 * and fills its missing columns via update_row_by_key.
 *
 * The update tool is passed in (not built here) so the shared rowIndex
 * closure from investigate-tool.ts is preserved across all agent calls
 * within one workflow run.
 *
 * A fresh agent instance is constructed per investigate_entity call;
 * do not cache.
 */
export function buildInvestigateAgent(
  columns: PopulateColumn[],
  primaryKeyColumn: string,
  updateRowByKeyTool: ReturnType<typeof import("@mastra/core/tools").createTool>,
): Agent {
  return new Agent({
    id: "investigate-agent",
    name: "Dataset Investigate Agent",
    instructions: buildInvestigateInstructions(columns, primaryKeyColumn),
    model: openrouter("deepseek/deepseek-v4-pro"),
    tools: {
      search_web: searchWebTool,
      fetch_page: fetchPageTool,
      update_row_by_key: updateRowByKeyTool,
    },
  });
}
