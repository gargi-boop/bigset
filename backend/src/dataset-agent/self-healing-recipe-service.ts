import { applyRecipePromotionDecision, decideRecipePromotion } from "./recipe-healer.js";
import type { DatasetRecipeStore } from "./recipe-store.js";
import type {
  DatasetRecipe,
  DatasetRecipeBenchmarkScore,
  DatasetRecipeRunResult,
  DatasetRecipeRuntime,
} from "./recipe-types.js";
import type { DatasetAgentRunInput } from "./types.js";

export interface DatasetRecipeAuthorGenerateInput {
  datasetId: string;
  runInput: DatasetAgentRunInput;
  nextVersion: number;
}

export interface DatasetRecipeAuthorRepairInput
  extends DatasetRecipeAuthorGenerateInput {
  activeRecipe: DatasetRecipe;
  failedRun: DatasetRecipeRunResult;
}

export interface DatasetRecipeAuthor {
  generateRecipe(
    input: DatasetRecipeAuthorGenerateInput
  ): Promise<DatasetRecipe>;
  repairRecipe(input: DatasetRecipeAuthorRepairInput): Promise<DatasetRecipe>;
}

export type DatasetRecipeBenchmarkScorer = (input: {
  recipe: DatasetRecipe;
  runInput: DatasetAgentRunInput;
  runResult: DatasetRecipeRunResult;
}) => Promise<DatasetRecipeBenchmarkScore | undefined>;

export type SelfHealingRecipeAction =
  | "active_rerun_succeeded"
  | "generated_initial_recipe"
  | "repaired_active_recipe"
  | "candidate_rejected";

export interface SelfHealingRecipeTickResult {
  datasetId: string;
  action: SelfHealingRecipeAction;
  activeRecipe?: DatasetRecipe;
  candidateRecipe?: DatasetRecipe;
  activeRun?: DatasetRecipeRunResult;
  candidateRun?: DatasetRecipeRunResult;
  rejectionReasons: string[];
}

export class SelfHealingRecipeService {
  constructor(
    private readonly input: {
      store: DatasetRecipeStore;
      runtime: DatasetRecipeRuntime;
      author: DatasetRecipeAuthor;
      benchmarkScorer?: DatasetRecipeBenchmarkScorer;
    }
  ) {}

  async tick(input: {
    datasetId: string;
    runInput: DatasetAgentRunInput;
  }): Promise<SelfHealingRecipeTickResult> {
    const activeRecipe = await this.input.store.getActiveRecipe(input.datasetId);

    if (!activeRecipe) {
      return this.generateInitialRecipe(input);
    }

    const activeRun = await this.input.runtime.runRecipe({
      recipe: activeRecipe,
      runInput: input.runInput,
    });
    await this.input.store.saveRunResult(input.datasetId, activeRun);

    if (isHealthyRun(activeRun)) {
      const updatedActiveRecipe = successfulRecipe(activeRecipe, activeRun);
      await this.input.store.saveRecipe(updatedActiveRecipe);
      return {
        datasetId: input.datasetId,
        action: "active_rerun_succeeded",
        activeRecipe: updatedActiveRecipe,
        activeRun,
        rejectionReasons: [],
      };
    }

    const candidateRecipe = await this.input.author.repairRecipe({
      datasetId: input.datasetId,
      runInput: input.runInput,
      activeRecipe,
      failedRun: activeRun,
      nextVersion: await this.nextVersion(input.datasetId),
    });
    const candidateRun = await this.runAndMaybeScoreCandidate({
      recipe: { ...candidateRecipe, status: "candidate" },
      runInput: input.runInput,
      datasetId: input.datasetId,
    });
    const promotion = applyRecipePromotionDecision({
      activeRecipe,
      candidateRecipe,
      activeRun,
      candidateRun,
    });

    if (promotion.decision.shouldPromote) {
      await this.input.store.saveRecipe(promotion.retiredRecipe!);
      await this.input.store.saveRecipe(promotion.activeRecipe);
      return {
        datasetId: input.datasetId,
        action: "repaired_active_recipe",
        activeRecipe: promotion.activeRecipe,
        candidateRecipe,
        activeRun,
        candidateRun,
        rejectionReasons: [],
      };
    }

    await this.input.store.saveRecipe({ ...candidateRecipe, status: "rejected" });
    return {
      datasetId: input.datasetId,
      action: "candidate_rejected",
      activeRecipe,
      candidateRecipe: { ...candidateRecipe, status: "rejected" },
      activeRun,
      candidateRun,
      rejectionReasons: promotion.decision.rejectionReasons,
    };
  }

  private async generateInitialRecipe(input: {
    datasetId: string;
    runInput: DatasetAgentRunInput;
  }): Promise<SelfHealingRecipeTickResult> {
    const candidateRecipe = await this.input.author.generateRecipe({
      datasetId: input.datasetId,
      runInput: input.runInput,
      nextVersion: await this.nextVersion(input.datasetId),
    });
    const candidateRun = await this.runAndMaybeScoreCandidate({
      recipe: { ...candidateRecipe, status: "candidate" },
      runInput: input.runInput,
      datasetId: input.datasetId,
    });
    const decision = decideRecipePromotion({ candidateRun });

    if (decision.shouldPromote) {
      const activeRecipe = successfulRecipe(candidateRecipe, candidateRun);
      await this.input.store.saveRecipe(activeRecipe);
      return {
        datasetId: input.datasetId,
        action: "generated_initial_recipe",
        activeRecipe,
        candidateRecipe,
        candidateRun,
        rejectionReasons: [],
      };
    }

    const rejectedRecipe = { ...candidateRecipe, status: "rejected" as const };
    await this.input.store.saveRecipe(rejectedRecipe);
    return {
      datasetId: input.datasetId,
      action: "candidate_rejected",
      candidateRecipe: rejectedRecipe,
      candidateRun,
      rejectionReasons: decision.rejectionReasons,
    };
  }

  private async runAndMaybeScoreCandidate(input: {
    recipe: DatasetRecipe;
    runInput: DatasetAgentRunInput;
    datasetId: string;
  }): Promise<DatasetRecipeRunResult> {
    await this.input.store.saveRecipe(input.recipe);
    const runResult = await this.input.runtime.runRecipe({
      recipe: input.recipe,
      runInput: input.runInput,
    });
    const benchmarkScore = await this.input.benchmarkScorer?.({
      recipe: input.recipe,
      runInput: input.runInput,
      runResult,
    });
    const scoredRunResult = benchmarkScore
      ? { ...runResult, benchmarkScore }
      : runResult;
    await this.input.store.saveRunResult(input.datasetId, scoredRunResult);
    return scoredRunResult;
  }

  private async nextVersion(datasetId: string): Promise<number> {
    const snapshot = await this.input.store.loadSnapshot(datasetId);
    const latestVersion = snapshot.recipes.reduce(
      (maxVersion, recipe) => Math.max(maxVersion, recipe.version),
      0
    );
    return latestVersion + 1;
  }
}

function isHealthyRun(runResult: DatasetRecipeRunResult): boolean {
  return (
    runResult.runStatus === "succeeded" &&
    runResult.productionValidation.isValid
  );
}

function successfulRecipe(
  recipe: DatasetRecipe,
  runResult: DatasetRecipeRunResult
): DatasetRecipe {
  return {
    ...recipe,
    status: "active",
    lastSuccessfulRunAt: runResult.completedAt,
    lastValidationScore: runResult.productionValidation.score,
  };
}
