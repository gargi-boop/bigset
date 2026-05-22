import assert from "node:assert/strict";
import { test } from "node:test";

import { finalizeExtractedRecord } from "../BigSet_Data_Collection_Agent/src/agents/extract.js";
import type { DatasetSpec } from "../BigSet_Data_Collection_Agent/src/models/schemas.js";

const docsSpec: DatasetSpec = {
  intent_summary: "Official docs pages.",
  target_row_count: 1,
  row_grain: "one row per docs page",
  columns: [
    {
      name: "entity_name",
      type: "string",
      description: "Vendor name.",
      required: true,
    },
    {
      name: "docs_url",
      type: "string",
      description: "Official docs URL.",
      required: true,
    },
    {
      name: "summary",
      type: "string",
      description: "What the page covers.",
      required: true,
    },
  ],
  dedupe_keys: ["entity_name"],
  search_queries: ["Cloudflare MCP docs"],
  extraction_hints: "Prefer official docs pages.",
};

test("collection extraction adds URL cell evidence when model omits evidence", () => {
  const record = finalizeExtractedRecord(
    {
      row: {
        entity_name: "Cloudflare",
        docs_url: "https://developers.cloudflare.com/agents/guides/remote-mcp-server/",
        summary: "Remote MCP server docs.",
      },
      evidence: [],
      extraction_confidence: 0.8,
    },
    "https://developers.cloudflare.com/agents/guides/remote-mcp-server/",
    docsSpec,
  );

  assert.deepEqual(record.evidence, [
    {
      field: "docs_url",
      url: "https://developers.cloudflare.com/agents/guides/remote-mcp-server/",
      quote: "https://developers.cloudflare.com/agents/guides/remote-mcp-server/",
    },
  ]);
  assert.deepEqual(record.source_urls, [
    "https://developers.cloudflare.com/agents/guides/remote-mcp-server/",
  ]);
});
