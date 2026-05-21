import assert from "node:assert/strict";
import { test } from "node:test";

import { pipelineResultToDatasetAgentResult } from "../src/dataset-agent/collection-bridge.js";
import type { PipelineResult } from "../BigSet_Data_Collection_Agent/src/orchestrator/pipeline.js";

test("pipelineResultToDatasetAgentResult passes through evidence and source urls", () => {
  const pipeline = minimalPipeline({
    row: {
      entity_name: "Stripe",
      pricing_page_url: "https://stripe.com/pricing",
    },
    source_urls: ["https://stripe.com/pricing"],
    evidence: [
      {
        field: "entity_name",
        url: "https://stripe.com/pricing",
        quote: "Stripe",
      },
    ],
  });

  const result = pipelineResultToDatasetAgentResult({
    pipeline,
    runInput: {
      prompt: "pricing",
      requiredColumns: ["entity_name", "pricing_page_url", "source_url"],
    },
  });

  assert.equal(result.rows[0]?.cells.entity_name, "Stripe");
  assert.deepEqual(result.rows[0]?.sourceUrls, ["https://stripe.com/pricing"]);
  assert.equal(result.rows[0]?.evidence[0]?.columnName, "entity_name");
  assert.equal(result.rows[0]?.evidence[0]?.sourceUrl, "https://stripe.com/pricing");
});

test("pipelineResultToDatasetAgentResult uses measured LLM usage when available", () => {
  const pipeline = minimalPipeline({
    row: { entity_name: "Stripe", pricing_page_url: "https://stripe.com/pricing" },
    source_urls: ["https://stripe.com/pricing"],
    evidence: [
      { field: "entity_name", url: "https://stripe.com/pricing", quote: "Stripe" },
    ],
  });
  pipeline.llmUsage = {
    promptTokens: 12_345,
    completionTokens: 6_789,
    totalTokens: 19_134,
    callCount: 42,
  };

  const result = pipelineResultToDatasetAgentResult({
    pipeline,
    runInput: {
      prompt: "pricing",
      requiredColumns: ["entity_name", "pricing_page_url", "source_url"],
    },
  });

  assert.equal(result.usage.promptTokens, 12_345);
  assert.equal(result.usage.completionTokens, 6_789);
  assert.equal(result.usage.totalTokens, 19_134);
});

function minimalPipeline(record: {
  row: Record<string, string>;
  source_urls: string[];
  evidence: Array<{ field: string; url: string; quote: string }>;
}): PipelineResult {
  return {
    runId: "test",
    paths: {} as PipelineResult["paths"],
    recordCount: 1,
    records: [record],
    visualizationRecords: [record],
    llmUsage: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      callCount: 0,
    },
    report: {
      run_id: "test",
      prompt: "test",
      target_rows: 1,
      started_at: "",
      finished_at: "",
      duration_ms: 0,
      dataset_spec: {
        intent_summary: "",
        target_row_count: 1,
        row_grain: "row",
        columns: [
          {
            name: "entity_name",
            type: "string",
            description: "",
            required: true,
          },
        ],
        dedupe_keys: ["entity_name"],
        search_queries: [],
        extraction_hints: "",
      },
      stats: {
        search_queries_executed: 1,
        search_results_collected: 1,
        unique_urls_selected: 1,
        pages_fetched: 1,
        pages_failed: 0,
        raw_records_extracted: 1,
        records_after_merge: 1,
      },
      initial: {
        search_queries_executed: 1,
        search_results_collected: 1,
        unique_urls_selected: 1,
        pages_fetched: 1,
        pages_failed: 0,
        raw_records_extracted: 1,
        search_queries: [],
        fetched_urls: [],
        failed_urls: [],
      },
      repair: {
        attempted: false,
        total_loops: 0,
        loops: [],
        missing_fields: [],
        repair_queries: [],
        records_before: 0,
        records_after: 0,
        fields_filled: {},
        stats: {
          search_queries_executed: 0,
          search_results_collected: 0,
          unique_urls_selected: 0,
          pages_fetched: 0,
          pages_failed: 0,
          raw_records_extracted: 0,
        },
      },
      search_queries: [],
      fetched_urls: [],
      failed_urls: [],
      errors: [],
    },
  };
}
