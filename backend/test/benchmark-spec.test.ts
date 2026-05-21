import assert from "node:assert/strict";
import { test } from "node:test";

import {
  mergeSpecWithBenchmarkRequiredColumns,
  parseRequiredColumns,
} from "../BigSet_Data_Collection_Agent/src/agents/benchmark-spec.js";
import type { DatasetSpec } from "../BigSet_Data_Collection_Agent/src/models/schemas.js";

const baseSpec: DatasetSpec = {
  intent_summary: "pricing",
  target_row_count: 3,
  row_grain: "company",
  columns: [
    {
      name: "company_name",
      type: "string",
      description: "legacy",
      required: true,
    },
  ],
  dedupe_keys: ["company_name"],
  search_queries: ["stripe pricing"],
  extraction_hints: "extract",
};

test("parseRequiredColumns splits and trims comma-separated names", () => {
  assert.deepEqual(
    parseRequiredColumns("entity_name, pricing_page_url ,source_url"),
    ["entity_name", "pricing_page_url", "source_url"],
  );
});

test("parseRequiredColumns rejects empty lists", () => {
  assert.throws(
    () => parseRequiredColumns("  ,  ,"),
    /at least one non-empty column name/,
  );
});

test("mergeSpecWithBenchmarkRequiredColumns adds required names without renaming aliases", () => {
  const merged = mergeSpecWithBenchmarkRequiredColumns(baseSpec, {
    requiredColumns: [
      "entity_name",
      "pricing_page_url",
      "plan_or_price",
      "source_url",
    ],
    expectedStress: "Official pricing pages only",
  });

  const names = merged.columns.map((column) => column.name);
  assert.ok(names.includes("entity_name"));
  assert.ok(names.includes("source_url"));
  assert.ok(names.includes("company_name"));
  assert.equal(
    merged.columns.find((column) => column.name === "entity_name")?.required,
    true,
  );
  assert.ok(merged.extraction_hints.includes("entity_name"));
  assert.ok(merged.extraction_hints.includes("Official pricing pages only"));
});

test("mergeSpecWithBenchmarkRequiredColumns uses a single dedupe key", () => {
  const merged = mergeSpecWithBenchmarkRequiredColumns(baseSpec, {
    requiredColumns: [
      "entity_name",
      "pricing_page_url",
      "plan_or_price",
      "source_url",
    ],
    expectedStress: "Official pricing pages only",
  });

  assert.deepEqual(merged.dedupe_keys, ["entity_name"]);
});
