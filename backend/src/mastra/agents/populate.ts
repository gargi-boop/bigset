import { Agent } from "@mastra/core/agent";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import {
  insertRowTool,
  listRowsTool,
  getRowTool,
  updateRowTool,
  deleteRowTool,
} from "../tools/dataset-tools.js";
import { searchWebTool, fetchPageTool } from "../tools/web-tools.js";

const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY!,
});

export const populateAgent = new Agent({
  id: "populate-agent",
  name: "Dataset Populate Agent",
  instructions: `You fill datasets with real data. Here's how:

1. Search the web for data that fits the dataset topic.
2. Fetch 1-2 pages to get details.
3. Call insert_row only for rows supported by search or fetched page content.

Never make up rows or missing cell values. If you can't find enough real data, insert fewer rows and explain the gap in your final response.`,
  model: openrouter("anthropic/claude-sonnet-4-6"),
  tools: {
    insert_row: insertRowTool,
    list_rows: listRowsTool,
    get_row: getRowTool,
    update_row: updateRowTool,
    delete_row: deleteRowTool,
    search_web: searchWebTool,
    fetch_page: fetchPageTool,
  },
});
