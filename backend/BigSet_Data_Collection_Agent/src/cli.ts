#!/usr/bin/env node
import { Command } from "commander";
import {
  parseRequiredColumns,
  type BenchmarkSpecContext,
} from "./agents/benchmark-spec.js";
import {
  defaultRunsDir,
  runPipeline,
  runRefreshPipeline,
} from "./orchestrator/pipeline.js";

const program = new Command();

program
  .name("bigset-collector")
  .description("Experimental pipeline: user prompt → CSV via Tinyfish + OpenRouter")
  .version("1.4.0");

const sharedFlags = {
  targetRows: ["-t, --target-rows <n>", "Target number of rows", "25"] as const,
  out: ["-o, --out <dir>", "Base output directory for runs", defaultRunsDir()] as const,
  noRepair: ["--no-repair", "Disable the search-repair loop"] as const,
  noTriage: ["--no-triage", "Skip source triage (extract all fetched pages)"] as const,
  noAgent: ["--no-agent", "Skip Tinyfish Agent (no navigation/form runs)"] as const,
  requiredColumns: [
    "--required-columns <names>",
    "Comma-separated benchmark required column names (same as prompts.json requiredColumns)",
  ] as const,
  expectedStress: [
    "--expected-stress <text>",
    "Optional benchmark expectedStress hint (pairs with --required-columns)",
  ] as const,
};

function benchmarkContextFromCli(options: {
  requiredColumns?: string;
  expectedStress?: string;
}): BenchmarkSpecContext | undefined {
  if (!options.requiredColumns) {
    return undefined;
  }
  return {
    requiredColumns: parseRequiredColumns(options.requiredColumns),
    ...(options.expectedStress ? { expectedStress: options.expectedStress } : {}),
  };
}

function printRunSummary(result: Awaited<ReturnType<typeof runPipeline>>): void {
  console.log("\n--- Run complete ---");
  console.log(`Run ID:     ${result.runId}`);
  if (result.report.refreshed_from_run_id) {
    console.log(`Refreshed:  from ${result.report.refreshed_from_run_id}`);
  }
  console.log(`Records:    ${result.recordCount} merged`);
  const viz = result.report.stats.visualization_records;
  if (viz !== undefined) {
    console.log(`Results:    ${viz} rows in selective results.csv`);
  }
  console.log(`CSV:        ${result.paths.resultsPath}`);
  if (result.report.stats.visualization_records !== undefined) {
    console.log(`Full CSV:   ${result.paths.resultsFullPath}`);
  }
  console.log(`Init CSV:   ${result.paths.initResultsPath}`);
  if (result.report.repair.attempted) {
    console.log(`Repair CSV: ${result.paths.repairResultsPath}`);
  }
  console.log(`Evidence:   ${result.paths.evidencePath}`);
  console.log(`Report:     ${result.paths.reportPath}`);
  if (result.report.repair.attempted) {
    console.log(
      `Repair:     ${result.report.repair.total_loops} loop(s), ` +
        `fields filled: ${Object.entries(result.report.repair.fields_filled)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${k}(${n})`)
          .join(", ") || "none"}`,
    );
  } else if (result.report.repair.skipped_reason) {
    console.log(`Repair:     skipped (${result.report.repair.skipped_reason})`);
  }
  if (result.report.errors.length > 0) {
    console.log(`Warnings:   ${result.report.errors.length} (see run_report.json)`);
  }
}

program
  .command("run")
  .description(
    "Run the data collection pipeline (v1.4 — see docs/v14-ai-sdk-benchmark-and-quality.md)",
  )
  .requiredOption("-p, --prompt <text>", "Data gathering prompt")
  .option(...sharedFlags.targetRows)
  .option(...sharedFlags.out)
  .option(...sharedFlags.noRepair)
  .option(...sharedFlags.noTriage)
  .option(...sharedFlags.noAgent)
  .option(...sharedFlags.requiredColumns)
  .option(...sharedFlags.expectedStress)
  .action(async (opts: {
    prompt: string;
    targetRows: string;
    out: string;
    repair: boolean;
    triage: boolean;
    agent: boolean;
    requiredColumns?: string;
    expectedStress?: string;
  }) => {
    const targetRows = Number.parseInt(opts.targetRows, 10);
    if (Number.isNaN(targetRows) || targetRows <= 0) {
      throw new Error("--target-rows must be a positive integer");
    }

    const benchmark = benchmarkContextFromCli(opts);
    if (benchmark) {
      console.log(
        `Benchmark criteria: required_columns=[${benchmark.requiredColumns.join(", ")}]` +
          (benchmark.expectedStress
            ? ` expected_stress="${benchmark.expectedStress}"`
            : ""),
      );
    }

    const result = await runPipeline({
      prompt: opts.prompt,
      targetRows,
      outputDir: opts.out,
      enableRepair: opts.repair !== false,
      enableTriage: opts.triage !== false,
      enableTinyfishAgent: opts.agent !== false,
      benchmark,
    });

    printRunSummary(result);
  });

program
  .command("refresh")
  .description(
    "Re-run search/fetch/extract for a prior run; merge by primary key (no duplicates)",
  )
  .requiredOption("--from-run <id>", "Run ID to refresh (under --out)")
  .option(...sharedFlags.targetRows)
  .option(...sharedFlags.out)
  .option(
    "--in-place",
    "Write into the same run folder (same run_id); default creates a new run",
  )
  .option(
    "--refetch-urls",
    "Allow re-fetching URLs already collected in the source run",
  )
  .option(...sharedFlags.noRepair)
  .option(...sharedFlags.noTriage)
  .option(...sharedFlags.noAgent)
  .action(async (opts: {
    fromRun: string;
    targetRows: string;
    out: string;
    inPlace: boolean;
    refetchUrls: boolean;
    repair: boolean;
    triage: boolean;
    agent: boolean;
  }) => {
    const targetRows = Number.parseInt(opts.targetRows, 10);
    if (Number.isNaN(targetRows) || targetRows <= 0) {
      throw new Error("--target-rows must be a positive integer");
    }

    const result = await runRefreshPipeline({
      fromRunId: opts.fromRun,
      outputDir: opts.out,
      targetRows,
      inPlace: opts.inPlace,
      refetchUrls: opts.refetchUrls,
      enableRepair: opts.repair !== false,
      enableTriage: opts.triage !== false,
      enableTinyfishAgent: opts.agent !== false,
    });

    printRunSummary(result);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
