import "dotenv/config";

import { parseRequiredColumns } from "../../BigSet_Data_Collection_Agent/src/agents/benchmark-spec.js";
import { createDatasetAgentRuntime } from "./index.js";

const prompt = requiredEnv("BIGSET_BENCHMARK_PROMPT");
const promptId = process.env.BIGSET_BENCHMARK_PROMPT_ID;
const promptQuality = process.env.BIGSET_BENCHMARK_PROMPT_QUALITY;
const requiredColumns = parseRequiredColumns(
  requiredEnv("BIGSET_BENCHMARK_REQUIRED_COLUMNS"),
);

const runtime = createDatasetAgentRuntime({
  runtime: process.env.DATASET_AGENT_RUNTIME ?? "collection",
});

const result = await runtime.runDatasetBuild({
  prompt,
  promptId,
  promptQuality,
  requiredColumns,
});

console.log(JSON.stringify(result));

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Run through run-benchmark.mjs.`);
  }
  return value;
}
