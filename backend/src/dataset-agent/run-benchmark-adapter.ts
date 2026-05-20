import "dotenv/config";

import { runDatasetAgentFromEnv } from "./index.js";

const prompt = requiredEnv("BIGSET_BENCHMARK_PROMPT");
const promptId = process.env.BIGSET_BENCHMARK_PROMPT_ID;
const promptQuality = process.env.BIGSET_BENCHMARK_PROMPT_QUALITY;
const requiredColumns = columnList(requiredEnv("BIGSET_BENCHMARK_REQUIRED_COLUMNS"));
const minimumRequiredColumns = columnListEnv(
  "BIGSET_BENCHMARK_MINIMUM_REQUIRED_COLUMNS"
);

const result = await runDatasetAgentFromEnv({
  prompt,
  promptId,
  promptQuality,
  requiredColumns,
  minimumRequiredColumns,
});

console.log(JSON.stringify(result));

function columnListEnv(name: string): string[] {
  return columnList(process.env[name] ?? "");
}

function columnList(value: string): string[] {
  return value
  .split(",")
  .map((columnName) => columnName.trim())
  .filter(Boolean);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Run through run-benchmark.mjs.`);
  }
  return value;
}
