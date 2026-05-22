import { readFile } from "node:fs/promises";

import {
  populateRuntimePrerequisiteError,
  type PopulateRuntimePrerequisites,
} from "./populate-runtime-prerequisites.js";
import { datasetContextSchema, type DatasetContext } from "./populate.js";
import { InMemoryPopulateRecipeStore } from "./populate-self-healing.js";
import {
  runSelfHealingPopulate,
  type PopulateDatasetRowWriter,
  type RunSelfHealingPopulateResult,
} from "./populate-self-healing-runner.js";

export interface PopulateSelfHealingCliOptions {
  contextPath?: string;
  shouldReadStdin: boolean;
  shouldCommitRows: boolean;
  recipeStoreDirectory?: string;
  maxRows?: number;
}

export interface PopulateSelfHealingCliDependencies {
  argv: string[];
  env: NodeJS.ProcessEnv;
  readFileText?: (path: string) => Promise<string>;
  readStdinText?: () => Promise<string>;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
  runSelfHealing?: typeof runSelfHealingPopulate;
  createRowWriter?: () => Promise<PopulateDatasetRowWriter>;
}

export async function runPopulateSelfHealingCli(
  input: PopulateSelfHealingCliDependencies
): Promise<number> {
  const writeStdout = input.writeStdout ?? ((text) => console.log(text));
  const writeStderr = input.writeStderr ?? ((text) => console.error(text));

  try {
    const options = parsePopulateSelfHealingCliArgs(input.argv);
    const prerequisiteError = populateRuntimePrerequisiteError(
      prerequisitesFromEnv(input.env, options.shouldCommitRows)
    );
    if (prerequisiteError) {
      writeStdout(JSON.stringify({
        success: false,
        error: prerequisiteError,
        dryRun: !options.shouldCommitRows,
      }));
      return 1;
    }

    const context = await readDatasetContext({
      options,
      readFileText: input.readFileText ?? ((path) => readFile(path, "utf8")),
      readStdinText: input.readStdinText ?? readProcessStdin,
    });
    const rowWriter = options.shouldCommitRows
      ? await (input.createRowWriter ?? defaultCreateRowWriter)()
      : undefined;
    const result = await (input.runSelfHealing ?? runSelfHealingPopulate)({
      context,
      store: options.shouldCommitRows
        ? undefined
        : new InMemoryPopulateRecipeStore(),
      recipeStoreDirectory: options.shouldCommitRows
        ? options.recipeStoreDirectory ?? input.env.POPULATE_RECIPE_STORE_DIR
        : undefined,
      rowWriter,
      shouldCommitRows: options.shouldCommitRows,
      runtime: options.maxRows === undefined
        ? undefined
        : await runtimeWithMaxRows(options.maxRows),
    });

    writeStdout(JSON.stringify(summaryForResult(result, !options.shouldCommitRows)));
    return result.success ? 0 : 2;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(message);
    writeStdout(JSON.stringify({ success: false, error: message }));
    return 1;
  }
}

export function parsePopulateSelfHealingCliArgs(
  argv: string[]
): PopulateSelfHealingCliOptions {
  const options: PopulateSelfHealingCliOptions = {
    shouldReadStdin: false,
    shouldCommitRows: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--context" || arg === "--context-file") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a file path or "-".`);
      }
      options.contextPath = value;
      options.shouldReadStdin = value === "-";
      index += 1;
    } else if (arg === "--stdin") {
      options.shouldReadStdin = true;
      options.contextPath = "-";
    } else if (arg === "--commit") {
      options.shouldCommitRows = true;
    } else if (arg === "--recipe-store-dir") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--recipe-store-dir requires a directory path.");
      }
      options.recipeStoreDirectory = value;
      index += 1;
    } else if (arg === "--max-rows") {
      const value = argv[index + 1];
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error("--max-rows requires a positive integer.");
      }
      options.maxRows = parsed;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.contextPath && !options.shouldReadStdin) {
    throw new Error("Missing --context <file> or --stdin.");
  }
  if (!options.shouldCommitRows && options.recipeStoreDirectory) {
    throw new Error("--recipe-store-dir requires --commit.");
  }
  return options;
}

async function readDatasetContext(input: {
  options: PopulateSelfHealingCliOptions;
  readFileText: (path: string) => Promise<string>;
  readStdinText: () => Promise<string>;
}): Promise<DatasetContext> {
  const text = input.options.shouldReadStdin
    ? await input.readStdinText()
    : await input.readFileText(input.options.contextPath!);
  return datasetContextSchema.parse(JSON.parse(text));
}

function prerequisitesFromEnv(
  env: NodeJS.ProcessEnv,
  shouldCommitRows: boolean
): PopulateRuntimePrerequisites {
  return {
    convexAdminKey: env.CONVEX_SELF_HOSTED_ADMIN_KEY,
    openRouterApiKey: env.OPENROUTER_API_KEY,
    tinyFishApiKey: env.TINYFISH_API_KEY,
    shouldCommitRows,
  };
}

async function defaultCreateRowWriter(): Promise<PopulateDatasetRowWriter> {
  const { ConvexPopulateDatasetRowWriter } = await import(
    "./populate-convex-writer.js"
  );
  return new ConvexPopulateDatasetRowWriter();
}

async function runtimeWithMaxRows(maxRows: number) {
  const { MastraPopulateRecipeRuntime } = await import(
    "./populate-self-healing.js"
  );
  return new MastraPopulateRecipeRuntime({ maxRows });
}

function summaryForResult(
  result: RunSelfHealingPopulateResult,
  isDryRun: boolean
) {
  const diagnosticRun = result.selectedRun ?? result.diagnosticRun;
  return {
    success: result.success,
    dryRun: isDryRun,
    action: result.action,
    datasetId: result.datasetId,
    committedRows: result.committedRows,
    rowCount: diagnosticRun?.rows.length ?? 0,
    validationIssues: result.validationIssues,
    rejectionReasons: result.rejectionReasons,
    productionValidation: diagnosticRun?.productionValidation,
    metrics: diagnosticRun?.metrics,
  };
}

async function readProcessStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
  }
  return text;
}
