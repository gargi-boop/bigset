import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { buildSubagentTool } from "../tools/investigate-tool.js";
import { buildExtractTool } from "../tools/extract-tool.js";
import { searchWebTool } from "../tools/web-tools.js";
import { env } from "../../env.js";
import type { AuthContext } from "../workflows/populate.js";
import type { PopulateColumn } from "../../pipeline/populate.js";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
});

function buildOrchestratorInstructions(targetRows: number): string {
  const now = new Date();
  const currentYear = now.getFullYear();

  return `You are an expert dataset builder. You conduct research using your web tools.
You do broad research to see which rows to add, and then you spin up sub-agents that can do the deep research and fill in each row for you.
Your job is to make sure you dispatch and manage your army of sub agents to build up a dataset with ${targetRows} rows in it.

When searching for current or recent information, include "${currentYear}" in your queries so results are up to date.

TOOLS:
- search_web: Search for pages that list or describe relevant entities.
- extract_pages: Fetch 1–5 URLs and extract all matching entities using a fast LLM. Returns:
  - entities: each with primary_keys (entity name always filled; URL/ID if visible on the page), partial_data (other column values found), hints (notes on finding missing values), source_url
  - leads: URLs from the page likely to have more matching entities
- run_subagent: Dispatch a deep-research agent for one entity to fully research and insert a row.

WORKFLOW:
1. Understand the data that is needed and do some research to find places on the web where this data may be obvious and easy to find.
2. Call extract_pages with those URLs. It returns entities ready to dispatch, plus leads (more pages to extract from).
3. For every entity returned by extract_pages, immediately call run_subagent:
   - entity_hint: the entity's name (from primary_keys, the name column)
   - primary_keys: all primary_keys found (entity name always present; URL/ID included if extract_pages found it)
   - context: partial_data from the entity
   - urls: [source_url] plus any useful links mentioned in hints
   - notes: the hints string
4. Use leads from extract_pages and clues from run_subagent results to steer your next searches and extract_pages calls. Keep going with new URLs and search angles in parallel.
5. Repeat until you have ${targetRows} rows.

This process should become faster overtime as you find new rows to build, and you keep invoking sub agents in parallel to fill them in.

Duplicates are rejected automatically based on primary key columns. If a subagent reports a duplicate, don't re-investigate the same entity — move on to a new one.
`;
}

/**
 * Build the orchestrator Agent for a populate run.
 *
 * The orchestrator discovers entities via search_web + extract_pages, then
 * hands each entity off to a run_subagent for deep research and row insertion.
 * It has no write tools itself — all dataset writes go through run_subagent.
 *
 * A fresh orchestrator (and extract tool with its per-run dedup set) is
 * constructed per workflow run; do not cache.
 */
export function buildPopulateAgent(
  authorizedDatasetId: string,
  authContext: AuthContext,
  columns: PopulateColumn[],
  datasetName: string,
  description: string,
): Agent {
  return new Agent({
    id: "populate-agent",
    name: "Dataset Populate Orchestrator",
    instructions: buildOrchestratorInstructions(env.BIGSET_POPULATE_TARGET_ROWS),
    model: openrouter(env.BIGSET_ORCHESTRATOR_MODEL),
    tools: {
      search_web: searchWebTool,
      extract_pages: buildExtractTool(datasetName, description, columns),
      run_subagent: buildSubagentTool(
        authorizedDatasetId,
        authContext,
        columns,
      ),
    },
  });
}
