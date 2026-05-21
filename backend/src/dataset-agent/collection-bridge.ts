import { toDatasetAgentUsage } from "../../BigSet_Data_Collection_Agent/src/llm/usage.js";
import { canonicalRecordId } from "../../BigSet_Data_Collection_Agent/src/merge/records.js";
import { qualityMapFromReport } from "../../BigSet_Data_Collection_Agent/src/export/csv-compiler.js";
import { config as collectionConfig } from "../../BigSet_Data_Collection_Agent/src/config.js";
import type { PipelineResult } from "../../BigSet_Data_Collection_Agent/src/orchestrator/pipeline.js";
import type { ExtractedRecord } from "../../BigSet_Data_Collection_Agent/src/models/schemas.js";

import { normalizeDatasetAgentResult } from "./output.js";
import type {
  DatasetAgentEvidence,
  DatasetAgentMetrics,
  DatasetAgentRow,
  DatasetAgentRunInput,
  DatasetAgentRunResult,
  DatasetAgentUsage,
} from "./types.js";

/**
 * Maps a completed collection pipeline run into the dataset-agent / benchmark JSON contract.
 * Row values, per-field evidence, and source_urls come from the pipeline as-is; quality
 * scoring supplies needsReview.
 */
export function pipelineResultToDatasetAgentResult(input: {
  pipeline: PipelineResult;
  runInput: DatasetAgentRunInput;
  usage?: Partial<DatasetAgentUsage>;
}): DatasetAgentRunResult {
  const { pipeline, runInput } = input;
  const spec = pipeline.report.dataset_spec;
  const qualityById = pipeline.report.quality
    ? qualityMapFromReport(pipeline.report.quality.records)
    : undefined;

  const records = selectOutputRecords(pipeline);
  const rows = records.map((record) =>
    recordToBenchmarkRow({
      record,
      spec,
      requiredColumns: runInput.requiredColumns,
      qualityById,
    })
  );

  const validationIssues = [
    ...pipeline.report.errors,
    ...(records.length === 0 ? ["No rows returned from collection pipeline."] : []),
  ];

  return normalizeDatasetAgentResult({
    rawOutput: {
      rows,
      validationIssues,
    },
    runInput,
    usage: input.usage ?? llmUsageFromPipeline(pipeline),
    metrics: metricsFromReport(pipeline.report),
  });
}

function selectOutputRecords(pipeline: PipelineResult): ExtractedRecord[] {
  if (
    collectionConfig.enableSelectiveResults &&
    pipeline.visualizationRecords.length > 0
  ) {
    return pipeline.visualizationRecords;
  }
  return pipeline.records;
}

function recordToBenchmarkRow(input: {
  record: ExtractedRecord;
  spec: PipelineResult["report"]["dataset_spec"];
  requiredColumns: string[];
  qualityById?: ReturnType<typeof qualityMapFromReport>;
}): DatasetAgentRow {
  const cells: DatasetAgentRow["cells"] = { ...input.record.row };

  for (const columnName of input.requiredColumns) {
    if (cells[columnName] === undefined) {
      cells[columnName] = null;
    }
  }

  const sourceUrls = uniqueHttpUrls(input.record.source_urls);

  const evidence: DatasetAgentEvidence[] = input.record.evidence
    .map((item) => ({
      columnName: item.field,
      sourceUrl: item.url || sourceUrls[0] || "",
      quote: item.quote,
    }))
    .filter((item) => item.quote.length > 0);

  const recordId = canonicalRecordId(input.record, input.spec);
  const quality = recordId ? input.qualityById?.get(recordId) : undefined;

  return {
    cells,
    sourceUrls,
    evidence,
    needsReview: quality?.needs_review ?? false,
  };
}

function metricsFromReport(
  report: PipelineResult["report"]
): DatasetAgentMetrics {
  const triage = report.stats.triage ?? report.initial.triage;
  const repairTriage = report.repair.stats.triage;
  const agentDispatched =
    (triage?.agent_dispatched ?? 0) + (repairTriage?.agent_dispatched ?? 0);

  return {
    searchCalls: report.stats.search_queries_executed,
    fetchCalls: report.stats.pages_fetched,
    browserCalls: agentDispatched,
    agentRuns: agentDispatched > 0 ? agentDispatched : 1,
    agentSteps:
      (triage?.agent_succeeded ?? 0) +
      (triage?.agent_failed ?? 0) +
      (repairTriage?.agent_succeeded ?? 0) +
      (repairTriage?.agent_failed ?? 0),
  };
}

function llmUsageFromPipeline(pipeline: PipelineResult): DatasetAgentUsage {
  if (pipeline.llmUsage.callCount > 0) {
    return toDatasetAgentUsage(pipeline.llmUsage);
  }

  const reportUsage = pipeline.report.llm_usage;
  if (reportUsage && reportUsage.call_count > 0) {
    return {
      promptTokens: reportUsage.prompt_tokens,
      completionTokens: reportUsage.completion_tokens,
      totalTokens: reportUsage.total_tokens,
    };
  }

  return estimateUsageFromReport(pipeline);
}

function estimateUsageFromReport(
  pipeline: PipelineResult,
): DatasetAgentUsage {
  const promptChars = pipeline.report.prompt.length;
  const rowChars = pipeline.recordCount * 120;
  const promptTokens = Math.max(1, Math.ceil((promptChars + rowChars) / 4));
  const completionTokens = Math.max(96, pipeline.recordCount * 48);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

function uniqueHttpUrls(urls: string[]): string[] {
  return Array.from(
    new Set(
      urls.filter((url) => typeof url === "string" && /^https?:\/\//i.test(url))
    )
  );
}
