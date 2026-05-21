import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BenchmarkSpecContext } from "../../BigSet_Data_Collection_Agent/src/agents/benchmark-spec.js";
import { runPipeline } from "../../BigSet_Data_Collection_Agent/src/orchestrator/pipeline.js";

import { pipelineResultToDatasetAgentResult } from "./collection-bridge.js";
import { DeterministicDatasetAgentRuntime } from "./deterministic-runtime.js";
import type { DatasetAgentRunInput, DatasetAgentRuntime } from "./types.js";

export class CollectionPipelineRuntime implements DatasetAgentRuntime {
  async runDatasetBuild(input: DatasetAgentRunInput) {
    if (process.env.COLLECTION_AGENT_RUNTIME === "deterministic") {
      return new DeterministicDatasetAgentRuntime().runDatasetBuild(input);
    }

    const outputDir = await mkdtemp(join(tmpdir(), "bigset-collection-"));
    const targetRows = numberEnv("COLLECTION_AGENT_TARGET_ROWS", 8);
    const enableRepair = boolEnv("COLLECTION_AGENT_ENABLE_REPAIR", false);

    const pipeline = await runPipeline({
      prompt: input.prompt,
      targetRows,
      outputDir,
      enableRepair,
      enableTriage: boolEnv("COLLECTION_AGENT_ENABLE_TRIAGE", true),
      enableTinyfishAgent: boolEnv("COLLECTION_AGENT_ENABLE_AGENT", true),
      benchmark: benchmarkContextFromRunInput(input),
      onLog: (stage, message) => {
        console.error(`[collection:${stage}] ${message}`);
      },
    });

    return pipelineResultToDatasetAgentResult({
      pipeline,
      runInput: input,
    });
  }
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function benchmarkContextFromRunInput(
  input: DatasetAgentRunInput
): BenchmarkSpecContext | undefined {
  if (input.requiredColumns.length === 0) {
    return undefined;
  }
  return {
    promptId: input.promptId,
    promptQuality: input.promptQuality,
    persona: input.persona,
    expectedStress: input.expectedStress,
    requiredColumns: input.requiredColumns,
  };
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}
