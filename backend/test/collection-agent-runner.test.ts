import assert from "node:assert/strict";
import { test } from "node:test";

import { runCollectionPopulatePipeline } from "../src/pipeline/collection-agent-runner.js";

test("collection agent runner maps vendored pipeline output into populate runtime result", async () => {
  const previousModule = process.env.COLLECTION_AGENT_PIPELINE_MODULE;
  process.env.COLLECTION_AGENT_PIPELINE_MODULE = fakeCollectionPipelineModuleUrl();
  try {
    const result = await runCollectionPopulatePipeline({
      datasetId: "dataset-ai-posts",
      datasetName: "AI posts",
      description: "Find latest AI blog posts.",
      columns: [
        { name: "entity_name", type: "text" },
        { name: "source_url", type: "url" },
        { name: "evidence_quote", type: "text" },
      ],
      requiredColumns: ["entity_name", "source_url", "evidence_quote"],
      prompt: [
        "Dataset: AI posts",
        "Task: Find latest AI blog posts.",
        "",
        "Durable recipe instructions:",
        "Prefer official source pages.",
      ].join("\n"),
      recipeInstructions: "Prefer official source pages.",
      targetRows: 3,
      promptId: "latest-ai-blog-posts",
      promptQuality: "easy",
      persona: "technical operator",
      expectedStress: "Latest dated source pages.",
    });

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.cells.entity_name, "OpenAI");
    assert.equal(result.rows[0]?.cells.evidence_quote, "technical operator");
    assert.deepEqual(result.rows[0]?.sourceUrls, ["https://openai.com/news"]);
    assert.equal(result.rows[0]?.evidence[0]?.columnName, "entity_name");
    assert.equal(result.rows[0]?.needsReview, true);
    assert.deepEqual(result.validationIssues, []);
    assert.deepEqual(result.usage, {
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
    });
    assert.equal(result.metrics.searchCalls, 2);
    assert.equal(result.metrics.fetchCalls, 3);
    assert.equal(result.metrics.browserCalls, 1);
  } finally {
    if (previousModule === undefined) {
      delete process.env.COLLECTION_AGENT_PIPELINE_MODULE;
    } else {
      process.env.COLLECTION_AGENT_PIPELINE_MODULE = previousModule;
    }
  }
});

function fakeCollectionPipelineModuleUrl(): string {
  const source = `
    export async function runPipeline(options) {
      if (!options.prompt.includes("Durable recipe instructions")) {
        throw new Error("recipe instructions missing from prompt");
      }
      if (!options.memoryDir || !options.memoryDir.includes("memory")) {
        throw new Error("isolated memory dir missing");
      }
      if (options.benchmark?.promptId !== "latest-ai-blog-posts") {
        throw new Error("prompt id missing from benchmark context");
      }
      if (options.benchmark?.persona !== "technical operator") {
        throw new Error("persona missing from benchmark context");
      }
      if (options.benchmark?.requiredColumns?.join(",") !== "entity_name,source_url,evidence_quote") {
        throw new Error("required columns missing from benchmark context");
      }
      return {
        report: {
          errors: [],
          dataset_spec: {
            columns: [{ name: "entity_name" }],
            dedupe_keys: ["entity_name"],
          },
          stats: {
            search_queries_executed: 2,
            pages_fetched: 3,
            triage: {
              agent_dispatched: 1,
              agent_succeeded: 1,
              agent_failed: 0,
            },
          },
          initial: {
            triage: {
              agent_dispatched: 1,
              agent_succeeded: 1,
              agent_failed: 0,
            },
          },
          repair: {
            stats: {
              triage: {
                agent_dispatched: 0,
                agent_succeeded: 0,
                agent_failed: 0,
              },
            },
          },
          quality: {
            records: [{ record_id: "pk:openai", needs_review: true }],
          },
          llm_usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        },
        records: [{
          row: {
            entity_name: "OpenAI",
            source_url: "https://openai.com/news",
            evidence_quote: options.benchmark.persona,
          },
          source_urls: ["https://openai.com/news"],
          evidence: [{
            field: "entity_name",
            url: "https://openai.com/news",
            quote: options.benchmark.expectedStress,
          }],
        }],
        llmUsage: {
          promptTokens: 11,
          completionTokens: 7,
          totalTokens: 18,
        },
      };
    }
  `;
  return `data:text/javascript,${encodeURIComponent(source)}`;
}
