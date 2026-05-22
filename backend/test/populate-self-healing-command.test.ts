import assert from "node:assert/strict";
import { test } from "node:test";

import type { DatasetContext } from "../src/pipeline/populate.js";
import type { RunSelfHealingPopulateResult } from "../src/pipeline/populate-self-healing-runner.js";
import {
  parsePopulateSelfHealingCliArgs,
  runPopulateSelfHealingCli,
} from "../src/pipeline/populate-self-healing-command.js";

const context: DatasetContext = {
  datasetId: "dataset-ai-posts",
  datasetName: "AI posts",
  description: "Find latest blog posts from OpenAI.",
  columns: [{
    name: "entity_name",
    type: "text",
    description: "Company name.",
  }],
};

test("self-healing CLI parses context and dry-run mode", () => {
  assert.deepEqual(parsePopulateSelfHealingCliArgs([
    "--context",
    "context.json",
    "--max-rows",
    "3",
  ]), {
    contextPath: "context.json",
    shouldReadStdin: false,
    shouldCommitRows: false,
    maxRows: 3,
  });
});

test("self-healing CLI dry run does not require Convex admin key or create writer", async () => {
  const stdout: string[] = [];
  let runCalls = 0;
  let writerCalls = 0;
  const exitCode = await runPopulateSelfHealingCli({
    argv: ["--context", "context.json"],
    env: {
      OPENROUTER_API_KEY: "openrouter",
      TINYFISH_API_KEY: "tinyfish",
    },
    readFileText: async () => JSON.stringify(context),
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => undefined,
    createRowWriter: async () => {
      writerCalls += 1;
      throw new Error("writer should not be created");
    },
    runSelfHealing: async (input) => {
      runCalls += 1;
      assert.equal(input.shouldCommitRows, false);
      assert.equal(input.rowWriter, undefined);
      assert.equal(input.recipeStoreDirectory, undefined);
      assert.ok(input.store);
      return successfulResult(input.context.datasetId);
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(runCalls, 1);
  assert.equal(writerCalls, 0);
  assert.equal(stdout.length, 1);
  const output = JSON.parse(stdout[0]!);
  assert.equal(output.success, true);
  assert.equal(output.dryRun, true);
  assert.equal(output.rowCount, 1);
});

test("self-healing CLI rejects durable recipe store on dry run", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let didReadContext = false;
  const exitCode = await runPopulateSelfHealingCli({
    argv: [
      "--stdin",
      "--recipe-store-dir",
      ".bigset/test-recipes",
    ],
    env: {
      OPENROUTER_API_KEY: "openrouter",
      TINYFISH_API_KEY: "tinyfish",
    },
    readStdinText: async () => {
      didReadContext = true;
      return JSON.stringify(context);
    },
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
    runSelfHealing: async () => {
      throw new Error("runtime should not run");
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(didReadContext, false);
  assert.equal(stdout.length, 1);
  assert.match(stdout[0]!, /--recipe-store-dir requires --commit/);
  assert.match(stderr.join("\n"), /--recipe-store-dir requires --commit/);
});

test("self-healing CLI commit mode preflights missing Convex key before runtime", async () => {
  const stdout: string[] = [];
  let runCalls = 0;
  const exitCode = await runPopulateSelfHealingCli({
    argv: ["--context", "context.json", "--commit"],
    env: {
      OPENROUTER_API_KEY: "openrouter",
      TINYFISH_API_KEY: "tinyfish",
    },
    readFileText: async () => JSON.stringify(context),
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => undefined,
    runSelfHealing: async () => {
      runCalls += 1;
      throw new Error("runtime should not run");
    },
  });

  assert.equal(exitCode, 1);
  assert.equal(runCalls, 0);
  assert.equal(stdout.length, 1);
  assert.match(stdout[0]!, /CONVEX_SELF_HOSTED_ADMIN_KEY/);
});

test("self-healing CLI exits 2 when tick rejects candidate", async () => {
  const stdout: string[] = [];
  const exitCode = await runPopulateSelfHealingCli({
    argv: ["--stdin"],
    env: {
      OPENROUTER_API_KEY: "openrouter",
      TINYFISH_API_KEY: "tinyfish",
    },
    readStdinText: async () => JSON.stringify(context),
    writeStdout: (text) => stdout.push(text),
    writeStderr: () => undefined,
    runSelfHealing: async (input) => rejectedResult(input.context.datasetId),
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.length, 1);
  const output = JSON.parse(stdout[0]!);
  assert.equal(output.success, false);
  assert.equal(output.action, "candidate_rejected");
  assert.match(output.validationIssues.join("\n"), /Still no evidence/);
});

test("self-healing CLI reports malformed context JSON as one stdout object", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runPopulateSelfHealingCli({
    argv: ["--context", "context.json"],
    env: {
      OPENROUTER_API_KEY: "openrouter",
      TINYFISH_API_KEY: "tinyfish",
    },
    readFileText: async () => "{ nope",
    writeStdout: (text) => stdout.push(text),
    writeStderr: (text) => stderr.push(text),
  });

  assert.equal(exitCode, 1);
  assert.equal(stdout.length, 1);
  assert.equal(JSON.parse(stdout[0]!).success, false);
  assert.match(stderr.join("\n"), /JSON/);
});

function successfulResult(datasetId: string): RunSelfHealingPopulateResult {
  return {
    success: true,
    action: "generated_initial_recipe",
    datasetId,
    selectedRun: {
      ...baseRun(datasetId),
      rows: [{
        cells: { entity_name: "OpenAI" },
        sourceUrls: ["https://openai.com/news"],
        evidence: [{
          columnName: "entity_name",
          sourceUrl: "https://openai.com/news",
          quote: "OpenAI",
        }],
        needsReview: true,
      }],
    },
    rejectionReasons: [],
    validationIssues: [],
    tick: {
      datasetId,
      action: "generated_initial_recipe",
      rejectionReasons: [],
    },
  };
}

function rejectedResult(datasetId: string): RunSelfHealingPopulateResult {
  return {
    success: false,
    action: "candidate_rejected",
    datasetId,
    diagnosticRun: {
      ...baseRun(datasetId),
      runStatus: "failed",
      validationIssues: ["Still no evidence."],
      productionValidation: {
        ...baseRun(datasetId).productionValidation,
        isValid: false,
        score: 0,
        criticalIssues: ["Still no evidence."],
      },
    },
    rejectionReasons: ["Still no evidence."],
    validationIssues: ["Still no evidence."],
    tick: {
      datasetId,
      action: "candidate_rejected",
      rejectionReasons: ["Still no evidence."],
    },
  };
}

function baseRun(datasetId: string): RunSelfHealingPopulateResult["selectedRun"] {
  return {
    rows: [],
    validationIssues: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    metrics: {
      searchCalls: 0,
      fetchCalls: 0,
      browserCalls: 0,
      agentRuns: 0,
      agentSteps: 0,
    },
    recipeId: `${datasetId}-recipe-v1`,
    recipeVersion: 1,
    runStatus: "succeeded",
    startedAt: "2026-05-22T00:00:00.000Z",
    completedAt: "2026-05-22T00:00:01.000Z",
    runtimeMs: 1_000,
    productionValidation: {
      isValid: true,
      score: 1,
      rowCount: 1,
      requestedCellCompletenessRatio: 1,
      sourceUrlCoverageRatio: 1,
      evidenceCoverageRatio: 1,
      expectedEntityCoverageRatio: 1,
      expectedEntities: [],
      missingExpectedEntities: [],
      criticalIssues: [],
      warnings: [],
    },
    artifacts: [],
  };
}
