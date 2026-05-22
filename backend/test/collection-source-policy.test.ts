import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyPromptSourcePolicyToSpec,
  applyPromptSourcePolicyToTriageResult,
  derivePromptSourcePolicy,
  promptSourceSearchQueries,
  sourceCandidatePolicyBoost,
  urlMatchesPromptSourcePolicy,
} from "../BigSet_Data_Collection_Agent/src/agents/source-policy.js";
import type {
  DatasetSpec,
  SourceCandidate,
  SourceTriageResult,
} from "../BigSet_Data_Collection_Agent/src/models/schemas.js";

test("prompt source policy derives official queries from the user's prompt", () => {
  const policy = derivePromptSourcePolicy(
    "For Stripe, Paddle, and Chargebee, collect the official pricing page URL and the plan names or starting prices shown on the page.",
  );

  assert.equal(policy.requiresOfficialSource, true);
  assert.deepEqual(
    policy.entities.map((entity) => entity.name),
    ["Stripe", "Paddle", "Chargebee"],
  );
  assert.deepEqual(promptSourceSearchQueries(policy).slice(0, 3), [
    "Stripe official pricing page",
    "Stripe billing pricing",
    "Paddle official pricing page",
  ]);
});

test("prompt source policy ignores generic durable recipe source wording", () => {
  const policy = derivePromptSourcePolicy(
    [
      "Dataset: benchmark_latest-ai-blog-posts",
      "Task: Can you make me a table of the latest blog posts from OpenAI, Anthropic, and Google DeepMind? I need title, publish date, and URL.",
      "",
      "Durable recipe instructions:",
      "Prefer official docs, pricing, blog, product, or company pages over third-party summaries.",
    ].join("\n"),
  );

  const queries = promptSourceSearchQueries(policy);

  assert.deepEqual(queries, [
    "OpenAI official blog latest post",
    "Anthropic official blog latest post",
    "Google DeepMind official blog latest post",
  ]);
});

test("prompt source policy adds official-source guidance without benchmark answer keys", () => {
  const spec: DatasetSpec = {
    intent_summary: "Collect pricing pages.",
    target_row_count: 3,
    row_grain: "one row per company",
    columns: [
      {
        name: "entity_name",
        type: "string",
        description: "Company.",
        required: true,
      },
      {
        name: "pricing_page_url",
        type: "string",
        description: "Official pricing URL.",
        required: true,
      },
    ],
    dedupe_keys: ["entity_name"],
    search_queries: ["SaaS pricing pages"],
    extraction_hints: "Extract plan names.",
  };

  const updated = applyPromptSourcePolicyToSpec(
    spec,
    "For Stripe and Paddle, collect the official pricing page URL.",
  );

  assert.equal(updated.search_queries[0], "Stripe official pricing page");
  assert.equal(updated.search_queries[1], "Stripe billing pricing");
  assert.equal(updated.search_queries[2], "Paddle official pricing page");
  assert.match(updated.extraction_hints, /Prompt source policy/);
  assert.match(updated.extraction_hints, /Stripe, Paddle/);
});

test("prompt source policy prefers entity-owned domains over third-party proof", () => {
  const policy = derivePromptSourcePolicy(
    "Find the latest investor relations earnings release page for Apple, Microsoft, and Nvidia.",
  );

  assert.equal(
    urlMatchesPromptSourcePolicy("https://investor.apple.com/newsroom/", policy),
    true,
  );
  assert.equal(
    urlMatchesPromptSourcePolicy("https://finance.yahoo.com/quote/AAPL", policy),
    false,
  );
  assert.equal(
    urlMatchesPromptSourcePolicy("https://cloud.google.com/blog/topics/threat-intelligence", {
      ...derivePromptSourcePolicy(
        "Can you make me a table of the latest blog posts from OpenAI, Anthropic, and Google DeepMind?",
      ),
    }),
    false,
  );
  assert.equal(
    urlMatchesPromptSourcePolicy(
      "https://openai.github.io/openai-agents-python/mcp/",
      derivePromptSourcePolicy(
        "I need official docs pages for setting up MCP servers from Anthropic, OpenAI, and Cloudflare.",
      ),
    ),
    false,
  );
});

test("prompt source policy downgrades third-party extraction triage", () => {
  const policy = derivePromptSourcePolicy(
    "For Stripe, Paddle, and Chargebee, collect the official pricing page URL and plan names.",
  );
  const triage: SourceTriageResult = {
    url: "https://www.trustradius.com/products/paddle/pricing",
    final_url: "https://www.trustradius.com/products/paddle/pricing",
    title: "Paddle Pricing",
    status: "extract_now",
    confidence: 0.9,
    source_data_confidence: 0.8,
    expected_yield: "complete",
    reasoning: "Page lists pricing information.",
  };

  const updated = applyPromptSourcePolicyToTriageResult(triage, policy);

  assert.equal(updated.status, "low_value");
  assert.equal(updated.expected_yield, "none");
  assert.match(updated.reasoning, /official\/canonical sources/);
});

test("prompt source policy boosts official candidates", () => {
  const policy = derivePromptSourcePolicy(
    [
      "Dataset: benchmark_mcp-docs-pages",
      "Task: I need official docs pages for setting up MCP servers from Anthropic, OpenAI, and Cloudflare. Give me title, URL, and what each page covers.",
      "",
      "Durable recipe instructions:",
      "Prefer official docs, pricing, blog, product, or company pages over third-party summaries.",
    ].join("\n"),
  );
  assert.deepEqual(
    policy.entities.map((entity) => entity.name),
    ["Anthropic", "OpenAI", "Cloudflare"],
  );
  assert.deepEqual(promptSourceSearchQueries(policy).slice(0, 4), [
    "Anthropic MCP connector docs",
    "Anthropic model context protocol docs",
    "OpenAI MCP connector docs",
    "OpenAI model context protocol docs",
  ]);
  const official: SourceCandidate = {
    url: "https://developers.cloudflare.com/agents/model-context-protocol/",
    title: "MCP servers",
    snippet: "Official Cloudflare docs for MCP server setup.",
    query: "Cloudflare official docs MCP server setup",
  };
  const thirdParty: SourceCandidate = {
    url: "https://example.com/cloudflare-mcp-guide",
    title: "Cloudflare MCP guide",
    snippet: "A blog guide to Cloudflare MCP.",
    query: "Cloudflare official docs MCP server setup",
  };

  assert.ok(
    sourceCandidatePolicyBoost(official, policy) >
      sourceCandidatePolicyBoost(thirdParty, policy),
  );
});
