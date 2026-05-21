import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";

import { runDatasetAgentFromEnv } from "./index.js";

loadBenchmarkEnvFiles();

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

function loadBenchmarkEnvFiles() {
  const backendDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../.."
  );
  const repoDirectory = resolve(backendDirectory, "..");
  const envPaths = [
    join(repoDirectory, ".env"),
    join(repoDirectory, ".env.local"),
    join(repoDirectory, ".env.development"),
    join(repoDirectory, ".env.development.local"),
    join(backendDirectory, ".env"),
    join(backendDirectory, ".env.local"),
    join(backendDirectory, ".env.development"),
    join(backendDirectory, ".env.development.local"),
  ];

  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      loadDotenv({ path: envPath, override: false });
    }
  }
}
