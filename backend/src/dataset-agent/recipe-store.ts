import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  DatasetRecipe,
  DatasetRecipeBenchmarkScore,
  DatasetRecipeProductionValidation,
  DatasetRecipeRunResult,
  DatasetRecipeRunStatus,
} from "./recipe-types.js";

export interface StoredDatasetRecipeRunRecord {
  recipeId: string;
  recipeVersion: number;
  runStatus: DatasetRecipeRunStatus;
  completedAt: string;
  productionValidation: DatasetRecipeProductionValidation;
  benchmarkScore?: DatasetRecipeBenchmarkScore;
  artifactCount: number;
  runResultUri?: string;
}

export interface DatasetRecipeStoreSnapshot {
  datasetId: string;
  recipes: DatasetRecipe[];
  runRecords: StoredDatasetRecipeRunRecord[];
}

export interface DatasetRecipeStore {
  loadSnapshot(datasetId: string): Promise<DatasetRecipeStoreSnapshot>;
  saveRecipe(recipe: DatasetRecipe): Promise<void>;
  saveRunResult(
    datasetId: string,
    runResult: DatasetRecipeRunResult
  ): Promise<void>;
  getActiveRecipe(datasetId: string): Promise<DatasetRecipe | undefined>;
}

export class InMemoryDatasetRecipeStore implements DatasetRecipeStore {
  private readonly snapshotsByDatasetId = new Map<
    string,
    DatasetRecipeStoreSnapshot
  >();

  async loadSnapshot(datasetId: string): Promise<DatasetRecipeStoreSnapshot> {
    return this.snapshotFor(datasetId);
  }

  async saveRecipe(recipe: DatasetRecipe): Promise<void> {
    const snapshot = this.snapshotFor(recipe.datasetId);
    const recipeIndex = snapshot.recipes.findIndex(
      (storedRecipe) => storedRecipe.recipeId === recipe.recipeId
    );
    if (recipeIndex >= 0) {
      snapshot.recipes[recipeIndex] = recipe;
    } else {
      snapshot.recipes.push(recipe);
    }
    snapshot.recipes.sort((left, right) => left.version - right.version);
  }

  async saveRunResult(
    datasetId: string,
    runResult: DatasetRecipeRunResult
  ): Promise<void> {
    const snapshot = this.snapshotFor(datasetId);
    snapshot.runRecords.push(runRecordFromResult(runResult));
  }

  async getActiveRecipe(datasetId: string): Promise<DatasetRecipe | undefined> {
    const snapshot = this.snapshotFor(datasetId);
    return snapshot.recipes
      .filter((recipe) => recipe.status === "active")
      .sort((left, right) => right.version - left.version)[0];
  }

  private snapshotFor(datasetId: string): DatasetRecipeStoreSnapshot {
    let snapshot = this.snapshotsByDatasetId.get(datasetId);
    if (!snapshot) {
      snapshot = { datasetId, recipes: [], runRecords: [] };
      this.snapshotsByDatasetId.set(datasetId, snapshot);
    }
    return snapshot;
  }
}

export class FileSystemDatasetRecipeStore implements DatasetRecipeStore {
  constructor(private readonly rootDirectory: string) {}

  async loadSnapshot(datasetId: string): Promise<DatasetRecipeStoreSnapshot> {
    const manifestPath = this.manifestPath(datasetId);
    try {
      const manifestText = await readFile(manifestPath, "utf8");
      const parsed = JSON.parse(manifestText) as DatasetRecipeStoreSnapshot;
      return {
        datasetId: parsed.datasetId,
        recipes: parsed.recipes ?? [],
        runRecords: parsed.runRecords ?? [],
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { datasetId, recipes: [], runRecords: [] };
      }
      throw error;
    }
  }

  async saveRecipe(recipe: DatasetRecipe): Promise<void> {
    const snapshot = await this.loadSnapshot(recipe.datasetId);
    const recipeIndex = snapshot.recipes.findIndex(
      (storedRecipe) => storedRecipe.recipeId === recipe.recipeId
    );
    if (recipeIndex >= 0) {
      snapshot.recipes[recipeIndex] = recipe;
    } else {
      snapshot.recipes.push(recipe);
    }
    snapshot.recipes.sort((left, right) => left.version - right.version);
    await this.writeSnapshot(snapshot);
  }

  async saveRunResult(
    datasetId: string,
    runResult: DatasetRecipeRunResult
  ): Promise<void> {
    const snapshot = await this.loadSnapshot(datasetId);
    const runResultUri = join(
      this.datasetDirectory(datasetId),
      "runs",
      `${runResult.completedAt.replace(/[:.]/g, "-")}-${runResult.recipeId}.json`
    );

    await mkdir(join(this.datasetDirectory(datasetId), "runs"), {
      recursive: true,
    });
    await writeFile(runResultUri, `${JSON.stringify(runResult, null, 2)}\n`);
    snapshot.runRecords.push({
      ...runRecordFromResult(runResult),
      runResultUri,
    });
    await this.writeSnapshot(snapshot);
  }

  async getActiveRecipe(datasetId: string): Promise<DatasetRecipe | undefined> {
    const snapshot = await this.loadSnapshot(datasetId);
    return snapshot.recipes
      .filter((recipe) => recipe.status === "active")
      .sort((left, right) => right.version - left.version)[0];
  }

  private async writeSnapshot(
    snapshot: DatasetRecipeStoreSnapshot
  ): Promise<void> {
    await mkdir(this.datasetDirectory(snapshot.datasetId), { recursive: true });
    await writeFile(
      this.manifestPath(snapshot.datasetId),
      `${JSON.stringify(snapshot, null, 2)}\n`
    );
  }

  private datasetDirectory(datasetId: string): string {
    return join(this.rootDirectory, safePathSegment(datasetId));
  }

  private manifestPath(datasetId: string): string {
    return join(this.datasetDirectory(datasetId), "manifest.json");
  }
}

function runRecordFromResult(
  runResult: DatasetRecipeRunResult
): StoredDatasetRecipeRunRecord {
  return {
    recipeId: runResult.recipeId,
    recipeVersion: runResult.recipeVersion,
    runStatus: runResult.runStatus,
    completedAt: runResult.completedAt,
    productionValidation: runResult.productionValidation,
    benchmarkScore: runResult.benchmarkScore,
    artifactCount: runResult.artifacts.length,
  };
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
