import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  createDatasetRecipe,
  FakeDatasetRecipeRuntime,
  FileSystemDatasetRecipeStore,
  InMemoryDatasetRecipeStore,
  SelfHealingRecipeService,
} from "../src/dataset-agent/index.js";
import type {
  DatasetAgentRunInput,
  DatasetRecipe,
  DatasetRecipeAuthor,
  DatasetRecipeRunResult,
} from "../src/dataset-agent/index.js";

const runInput: DatasetAgentRunInput = {
  prompt: "Find latest blog posts from OpenAI with title and source URL.",
  promptId: "self-healing-fixture",
  promptQuality: "good",
  requiredColumns: ["entity_name", "latest_post_title", "source_url"],
};

test("reruns healthy active recipe without author or benchmark scorer", async () => {
  const store = new InMemoryDatasetRecipeStore();
  const activeRecipe = recipe({ recipeId: "healthy-active", status: "active" });
  await store.saveRecipe(activeRecipe);
  const author = new FakeRecipeAuthor();
  let benchmarkCalls = 0;
  const service = new SelfHealingRecipeService({
    store,
    runtime: new FakeDatasetRecipeRuntime({
      [activeRecipe.recipeId]: validScenario(),
    }),
    author,
    benchmarkScorer: async () => {
      benchmarkCalls += 1;
      return { score: 1, passed: true };
    },
  });

  const result = await service.tick({ datasetId: activeRecipe.datasetId, runInput });

  assert.equal(result.action, "active_rerun_succeeded");
  assert.equal(author.generateCalls, 0);
  assert.equal(author.repairCalls, 0);
  assert.equal(benchmarkCalls, 0);
  assert.equal(result.activeRecipe?.status, "active");
  assert.equal(result.activeRun?.productionValidation.isValid, true);
});

test("generates and activates first recipe when no active recipe exists", async () => {
  const store = new InMemoryDatasetRecipeStore();
  const generatedRecipe = recipe({ recipeId: "generated-v1", version: 1 });
  const author = new FakeRecipeAuthor({ generatedRecipe });
  const service = new SelfHealingRecipeService({
    store,
    runtime: new FakeDatasetRecipeRuntime({
      [generatedRecipe.recipeId]: validScenario(),
    }),
    author,
  });

  const result = await service.tick({
    datasetId: generatedRecipe.datasetId,
    runInput,
  });
  const snapshot = await store.loadSnapshot(generatedRecipe.datasetId);

  assert.equal(result.action, "generated_initial_recipe");
  assert.equal(result.activeRecipe?.recipeId, generatedRecipe.recipeId);
  assert.equal(result.activeRecipe?.version, 1);
  assert.equal(snapshot.recipes[0]?.status, "active");
  assert.equal(snapshot.runRecords.length, 1);
});

test("repairs failed active recipe and promotes valid candidate", async () => {
  const store = new InMemoryDatasetRecipeStore();
  const activeRecipe = recipe({ recipeId: "broken-active", status: "active" });
  const repairedRecipe = recipe({ recipeId: "repair-v2", version: 2 });
  await store.saveRecipe(activeRecipe);
  const author = new FakeRecipeAuthor({ repairedRecipe });
  const service = new SelfHealingRecipeService({
    store,
    runtime: new FakeDatasetRecipeRuntime({
      [activeRecipe.recipeId]: invalidScenario("Old selector failed."),
      [repairedRecipe.recipeId]: validScenario(),
    }),
    author,
  });

  const result = await service.tick({ datasetId: activeRecipe.datasetId, runInput });
  const snapshot = await store.loadSnapshot(activeRecipe.datasetId);

  assert.equal(result.action, "repaired_active_recipe");
  assert.equal(author.repairCalls, 1);
  assert.equal(author.lastRepairInput?.failedRun.artifacts[0]?.kind, "stderr");
  assert.equal(snapshot.recipes.find((item) => item.recipeId === activeRecipe.recipeId)?.status, "retired");
  assert.equal(snapshot.recipes.find((item) => item.recipeId === repairedRecipe.recipeId)?.status, "active");
});

test("keeps active recipe when repaired candidate fails validation", async () => {
  const store = new InMemoryDatasetRecipeStore();
  const activeRecipe = recipe({ recipeId: "still-active", status: "active" });
  const badCandidate = recipe({ recipeId: "bad-repair", version: 2 });
  await store.saveRecipe(activeRecipe);
  const service = new SelfHealingRecipeService({
    store,
    runtime: new FakeDatasetRecipeRuntime({
      [activeRecipe.recipeId]: invalidScenario("Active failed."),
      [badCandidate.recipeId]: invalidScenario("Repair failed."),
    }),
    author: new FakeRecipeAuthor({ repairedRecipe: badCandidate }),
  });

  const result = await service.tick({ datasetId: activeRecipe.datasetId, runInput });
  const snapshot = await store.loadSnapshot(activeRecipe.datasetId);

  assert.equal(result.action, "candidate_rejected");
  assert.equal(snapshot.recipes.find((item) => item.recipeId === activeRecipe.recipeId)?.status, "active");
  assert.equal(snapshot.recipes.find((item) => item.recipeId === badCandidate.recipeId)?.status, "rejected");
});

test("rejects candidate when benchmark score regresses", async () => {
  const store = new InMemoryDatasetRecipeStore();
  const activeRecipe = recipe({ recipeId: "benchmark-active", status: "active" });
  const candidateRecipe = recipe({ recipeId: "benchmark-candidate", version: 2 });
  await store.saveRecipe(activeRecipe);
  const service = new SelfHealingRecipeService({
    store,
    runtime: new FakeDatasetRecipeRuntime({
      [activeRecipe.recipeId]: {
        ...invalidScenario("Active failed."),
        benchmarkScore: { score: 0.9, passed: true },
      },
      [candidateRecipe.recipeId]: validScenario(),
    }),
    author: new FakeRecipeAuthor({ repairedRecipe: candidateRecipe }),
    benchmarkScorer: async () => ({ score: 0.7, passed: true }),
  });

  const result = await service.tick({ datasetId: activeRecipe.datasetId, runInput });

  assert.equal(result.action, "candidate_rejected");
  assert.match(result.rejectionReasons.join("\n"), /benchmark score regressed/i);
});

test("file store reloads recipe versions and run records", async () => {
  const rootDirectory = await mkdtemp(join(tmpdir(), "bigset-recipes-"));
  const store = new FileSystemDatasetRecipeStore(rootDirectory);
  const generatedRecipe = recipe({ recipeId: "persisted-v1", version: 1 });
  const service = new SelfHealingRecipeService({
    store,
    runtime: new FakeDatasetRecipeRuntime({
      [generatedRecipe.recipeId]: validScenario(),
    }),
    author: new FakeRecipeAuthor({ generatedRecipe }),
  });

  await service.tick({ datasetId: generatedRecipe.datasetId, runInput });

  const reloadedStore = new FileSystemDatasetRecipeStore(rootDirectory);
  const snapshot = await reloadedStore.loadSnapshot(generatedRecipe.datasetId);

  assert.equal(snapshot.recipes.length, 1);
  assert.equal(snapshot.recipes[0]?.status, "active");
  assert.equal(snapshot.runRecords.length, 1);
  assert.equal(snapshot.runRecords[0]?.runStatus, "succeeded");
});

function recipe(input: {
  recipeId: string;
  version?: number;
  status?: DatasetRecipe["status"];
}): DatasetRecipe {
  return createDatasetRecipe({
    recipeId: input.recipeId,
    datasetId: "dataset-ai-posts",
    version: input.version ?? 1,
    status: input.status ?? "candidate",
    scriptText: "export async function runDatasetRecipe() {}",
    requestedColumns: runInput.requiredColumns,
    sourcePrompt: runInput.prompt,
    createdAt: "2026-05-21T00:00:00.000Z",
  });
}

function validScenario() {
  return {
    rawOutput: {
      rows: [
        {
          cells: {
            entity_name: "OpenAI",
            latest_post_title: "Release notes",
            source_url: "https://openai.com/news",
          },
          sourceUrls: ["https://openai.com/news"],
          evidence: [
            {
              columnName: "latest_post_title",
              sourceUrl: "https://openai.com/news",
              quote: "Release notes",
            },
          ],
          needsReview: false,
        },
      ],
      validationIssues: [],
    },
    completedAt: "2026-05-21T00:02:00.000Z",
  };
}

function invalidScenario(message: string) {
  return {
    rawOutput: {
      rows: [],
      validationIssues: [message],
    },
    artifacts: [
      {
        kind: "stderr" as const,
        label: "stderr",
        content: message,
      },
    ],
    completedAt: "2026-05-21T00:03:00.000Z",
  };
}

class FakeRecipeAuthor implements DatasetRecipeAuthor {
  generateCalls = 0;
  repairCalls = 0;
  lastRepairInput?: Parameters<DatasetRecipeAuthor["repairRecipe"]>[0];

  constructor(
    private readonly recipes: {
      generatedRecipe?: DatasetRecipe;
      repairedRecipe?: DatasetRecipe;
    } = {}
  ) {}

  async generateRecipe(): Promise<DatasetRecipe> {
    this.generateCalls += 1;
    return this.recipes.generatedRecipe ?? recipe({ recipeId: "generated" });
  }

  async repairRecipe(
    input: Parameters<DatasetRecipeAuthor["repairRecipe"]>[0]
  ): Promise<DatasetRecipe> {
    this.repairCalls += 1;
    this.lastRepairInput = input;
    return this.recipes.repairedRecipe ?? recipe({ recipeId: "repaired", version: 2 });
  }
}
