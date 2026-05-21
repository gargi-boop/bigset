import assert from "node:assert/strict";
import { test } from "node:test";

import {
  finalizeExtractedRecord,
  isProvenanceUrlColumn,
} from "../BigSet_Data_Collection_Agent/src/agents/extract.js";
import type { DatasetSpec } from "../BigSet_Data_Collection_Agent/src/models/schemas.js";

const spec: DatasetSpec = {
  intent_summary: "test",
  target_row_count: 1,
  row_grain: "entity",
  columns: [
    {
      name: "entity_name",
      type: "string",
      description: "Name",
      required: true,
    },
    {
      name: "pricing_page_url",
      type: "string",
      description: "Official pricing page URL",
      required: true,
    },
    {
      name: "source_url",
      type: "string",
      description: "URL where evidence was found",
      required: true,
    },
  ],
  dedupe_keys: ["entity_name"],
  search_queries: ["test"],
  extraction_hints: "test",
};

test("isProvenanceUrlColumn identifies source_url and not content URLs", () => {
  assert.equal(
    isProvenanceUrlColumn({
      name: "source_url",
      type: "string",
      description: "evidence",
      required: true,
    }),
    true,
  );
  assert.equal(
    isProvenanceUrlColumn({
      name: "pricing_page_url",
      type: "string",
      description: "Official pricing page",
      required: true,
    }),
    false,
  );
});

test("finalizeExtractedRecord keeps LLM row provenance and sparse evidence", () => {
  const pageUrl = "https://stripe.com/pricing";
  const record = finalizeExtractedRecord(
    {
      row: {
        entity_name: "Stripe",
        pricing_page_url: "https://stripe.com/pricing",
        plan_or_price: "2.9% + 30¢",
        source_url: "https://stripe.com/pricing",
      },
      evidence: [
        {
          field: "plan_or_price",
          quote: "2.9% + 30¢ per successful card charge",
        },
      ],
      extraction_confidence: 0.85,
    },
    pageUrl,
    spec,
  );

  assert.equal(record.row.source_url, "https://stripe.com/pricing");
  assert.equal(record.row.pricing_page_url, "https://stripe.com/pricing");
  assert.equal(record.evidence.length, 1);
  assert.equal(record.evidence[0]?.field, "plan_or_price");
  assert.equal(record.evidence[0]?.url, pageUrl);
  assert.equal(record.extraction_confidence, 0.85);
  assert.ok(record.source_urls.includes(pageUrl));
});

test("finalizeExtractedRecord hydrates empty row fields from evidence", () => {
  const pageUrl = "https://sierra.ai/careers";
  const record = finalizeExtractedRecord(
    {
      row: {},
      evidence: [
        { field: "company_name", quote: "Sierra" },
        {
          field: "is_hiring",
          quote: "We're looking for exceptional people to join our growing team.",
        },
      ],
      extraction_confidence: 0.9,
    },
    pageUrl,
    {
      ...spec,
      columns: [
        {
          name: "company_name",
          type: "string",
          description: "Company name",
          required: true,
        },
        {
          name: "website_url",
          type: "string",
          description: "Website",
          required: true,
        },
        {
          name: "is_hiring",
          type: "boolean",
          description: "Currently hiring",
          required: true,
        },
      ],
      dedupe_keys: ["company_name"],
    },
  );

  assert.equal(record.row.company_name, "Sierra");
  assert.equal(record.row.is_hiring, true);
});

test("finalizeExtractedRecord falls back source_url to page only when LLM left it empty", () => {
  const pageUrl = "https://example.com/page";
  const record = finalizeExtractedRecord(
    {
      row: {
        entity_name: "Example Co",
        pricing_page_url: "https://example.com/pricing",
        source_url: null,
      },
      evidence: [],
      extraction_confidence: 0.7,
    },
    pageUrl,
    spec,
  );

  assert.equal(record.row.source_url, pageUrl);
  assert.equal(record.row.pricing_page_url, "https://example.com/pricing");
  assert.equal(record.evidence.length, 0);
});
