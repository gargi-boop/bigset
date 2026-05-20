export type DatasetAgentCellValue =
  | string
  | number
  | boolean
  | null
  | Record<string, unknown>
  | unknown[];

export interface DatasetAgentRunInput {
  prompt: string;
  promptId?: string;
  promptQuality?: string;
  /**
   * Columns the caller wants back for scoring/completeness. These are not all
   * hard row-acceptance requirements.
   */
  requiredColumns: string[];
  /**
   * Tiny identity fields that must be present before a row can be accepted.
   * When omitted, the runtime infers a conservative identity column from
   * requiredColumns.
   */
  minimumRequiredColumns?: string[];
}

export interface DatasetAgentEvidence {
  columnName: string;
  sourceUrl: string;
  quote: string;
}

export interface DatasetAgentRow {
  cells: Record<string, DatasetAgentCellValue>;
  sourceUrls: string[];
  evidence: DatasetAgentEvidence[];
  needsReview: boolean;
}

export interface DatasetAgentUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface DatasetAgentMetrics {
  searchCalls: number;
  fetchCalls: number;
  browserCalls: number;
  agentRuns: number;
  agentSteps: number;
}

export interface DatasetAgentRunResult {
  rows: DatasetAgentRow[];
  validationIssues: string[];
  usage: DatasetAgentUsage;
  metrics: DatasetAgentMetrics;
}

export interface DatasetAgentRuntime {
  runDatasetBuild(input: DatasetAgentRunInput): Promise<DatasetAgentRunResult>;
}

export interface DatasetAgentSearchResult {
  title: string;
  url: string;
  snippet?: string;
  position?: number;
}

export interface DatasetAgentFetchedPage {
  url: string;
  finalUrl?: string | null;
  title?: string | null;
  text?: string | null;
}

export interface DatasetAgentBrowserResult {
  url: string;
  status: "completed" | "failed" | "running" | "pending" | "cancelled";
  payload: Record<string, unknown> | null;
  errorMessage?: string | null;
  stepCount?: number | null;
}

export interface DatasetAgentToolProvider {
  search(input: { query: string }): Promise<DatasetAgentSearchResult[]>;
  fetch(input: { urls: string[] }): Promise<DatasetAgentFetchedPage[]>;
  browser(input: {
    url: string;
    goal: string;
  }): Promise<DatasetAgentBrowserResult>;
}
