import type {
  DatasetAgentCellValue,
  DatasetAgentEvidence,
  DatasetAgentMetrics,
  DatasetAgentRow,
  DatasetAgentRunInput,
  DatasetAgentRunResult,
  DatasetAgentUsage,
} from "./types.js";

export function emptyUsage(): DatasetAgentUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

export function emptyMetrics(): DatasetAgentMetrics {
  return {
    searchCalls: 0,
    fetchCalls: 0,
    browserCalls: 0,
    agentRuns: 0,
    agentSteps: 0,
  };
}

export function minimumRequiredColumnsForRunInput(
  input: DatasetAgentRunInput
): string[] {
  const configuredMinimumColumns = uniqueStrings(
    input.minimumRequiredColumns ?? []
  );
  if (configuredMinimumColumns.length > 0) {
    return configuredMinimumColumns;
  }

  return inferConservativeMinimumRequiredColumns(input.requiredColumns);
}

export function normalizeDatasetAgentResult(input: {
  rawOutput: unknown;
  runInput: DatasetAgentRunInput;
  usage?: Partial<DatasetAgentUsage>;
  metrics?: Partial<DatasetAgentMetrics>;
}): DatasetAgentRunResult {
  const outputRecord = isRecord(input.rawOutput) ? input.rawOutput : {};
  const rows = arrayValue(
    outputRecord.rows ??
      outputRecord.data ??
      outputRecord.records ??
      outputRecord.result
  ).map((row) => normalizeRow(row, input.runInput));
  const validationIssues = [
    ...stringArrayValue(
      outputRecord.validationIssues ??
        outputRecord.issues ??
        outputRecord.errors
    ),
    ...validateRows({
      rows,
      minimumRequiredColumns: minimumRequiredColumnsForRunInput(input.runInput),
    }),
  ];

  return {
    rows,
    validationIssues: Array.from(new Set(validationIssues)),
    usage: {
      ...emptyUsage(),
      ...normalizeUsage(outputRecord.usage),
      ...input.usage,
    },
    metrics: {
      ...emptyMetrics(),
      ...normalizeMetrics(outputRecord.metrics),
      ...input.metrics,
    },
  };
}

export function parseOutputFromText(text: string): unknown {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return {};
  }

  try {
    return JSON.parse(trimmedText);
  } catch {
    const jsonObject = extractFirstJsonObject(trimmedText);
    return jsonObject ? JSON.parse(jsonObject) : {};
  }
}

function normalizeRow(row: unknown, runInput: DatasetAgentRunInput): DatasetAgentRow {
  const rowRecord = isRecord(row) ? row : {};
  const explicitCells = normalizeCells(
    rowRecord.cells ?? rowRecord.data ?? rowRecord
  );
  const sourceUrls = normalizeSourceUrls(rowRecord, explicitCells);
  const evidence = normalizeEvidence(rowRecord, sourceUrls);
  const evidenceBackedCells = fillMissingCellsFromEvidence(
    explicitCells,
    evidence
  );
  const cells = fillMissingCellsFromRunContext({
    cells: evidenceBackedCells,
    sourceUrls,
    runInput,
  });

  return {
    cells,
    sourceUrls,
    evidence,
    needsReview: rowRecord.needsReview === true || rowRecord.needs_review === true,
  };
}

function normalizeCells(value: unknown): Record<string, DatasetAgentCellValue> {
  if (!isRecord(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).map(([columnName, cellValue]) => [
      columnName,
      normalizeCellValue(cellValue),
    ])
  );
}

function normalizeCellValue(value: unknown): DatasetAgentCellValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null ||
    Array.isArray(value)
  ) {
    return value;
  }
  if (isRecord(value)) {
    return value;
  }
  return null;
}

function fillMissingCellsFromEvidence(
  cells: Record<string, DatasetAgentCellValue>,
  evidence: DatasetAgentEvidence[]
): Record<string, DatasetAgentCellValue> {
  const filledCells = { ...cells };

  for (const item of evidence) {
    const columnName = item.columnName.trim();
    const quote = item.quote.trim();
    if (!columnName || !quote || isPresent(filledCells[columnName])) {
      continue;
    }
    filledCells[columnName] = quote;
  }

  return filledCells;
}

function fillMissingCellsFromRunContext(input: {
  cells: Record<string, DatasetAgentCellValue>;
  sourceUrls: string[];
  runInput: DatasetAgentRunInput;
}): Record<string, DatasetAgentCellValue> {
  const filledCells = { ...input.cells };
  const firstSourceUrl = input.sourceUrls[0];

  if (firstSourceUrl) {
    for (const columnName of input.runInput.requiredColumns) {
      if (isUrlColumn(columnName) && !isPresent(filledCells[columnName])) {
        filledCells[columnName] = firstSourceUrl;
      }
    }
  }

  const identityColumnName = minimumRequiredColumnsForRunInput(
    input.runInput
  ).find((columnName) => isIdentityColumn(columnName));
  if (
    identityColumnName &&
    !isPresent(filledCells[identityColumnName]) &&
    input.sourceUrls.length > 0
  ) {
    const entityName = inferEntityNameFromPromptAndSourceUrls({
      prompt: input.runInput.prompt,
      sourceUrls: input.sourceUrls,
    });
    if (entityName) {
      filledCells[identityColumnName] = entityName;
    }
  }

  return filledCells;
}

function normalizeSourceUrls(
  row: Record<string, unknown>,
  cells: Record<string, DatasetAgentCellValue>
): string[] {
  return Array.from(
    new Set(
      [
        ...stringArrayValue(row.sourceUrls),
        ...stringArrayValue(row.sources),
        ...stringArrayValue(row.source_urls),
        ...singleStringArray(row.sourceUrl),
        ...singleStringArray(row.source_url),
        ...singleStringArray(cells.source_url),
        ...singleStringArray(cells.sourceUrl),
      ].filter((sourceUrl) => /^https?:\/\//i.test(sourceUrl))
    )
  );
}

function normalizeEvidence(
  row: Record<string, unknown>,
  sourceUrls: string[]
): DatasetAgentEvidence[] {
  const rawEvidence = arrayValue(
    row.evidence ?? row.evidenceQuotes ?? row.evidence_quotes
  );

  return rawEvidence
    .map((item) => {
      if (typeof item === "string") {
        return {
          columnName: "entity_name",
          sourceUrl: sourceUrls[0] ?? "",
          quote: item,
        };
      }
      if (!isRecord(item)) {
        return null;
      }
      const columnName = stringValue(item.columnName) ?? "entity_name";
      const sourceUrl = stringValue(item.sourceUrl) ?? sourceUrls[0] ?? "";
      const quote = stringValue(item.quote);
      return quote ? { columnName, sourceUrl, quote } : null;
    })
    .filter(isNotNull);
}

function validateRows(input: {
  rows: DatasetAgentRow[];
  minimumRequiredColumns: string[];
}): string[] {
  const issues: string[] = [];
  if (input.rows.length === 0) {
    issues.push("No rows returned.");
  }

  for (const [rowIndex, row] of input.rows.entries()) {
    if (row.sourceUrls.length === 0) {
      issues.push(`Row ${rowIndex} has no source URL.`);
    }
    if (row.evidence.length === 0) {
      issues.push(`Row ${rowIndex} has no evidence quote.`);
    }
    for (const columnName of input.minimumRequiredColumns) {
      if (!isPresent(row.cells[columnName])) {
        issues.push(`Row ${rowIndex} missing minimum required column ${columnName}.`);
      }
    }
  }

  return issues;
}

function inferConservativeMinimumRequiredColumns(columns: string[]): string[] {
  const requestedColumns = uniqueStrings(columns);
  const identityPriority = [
    "entity_name",
    "company_name",
    "organization_name",
    "provider_name",
    "restaurant_name",
    "store_name",
    "business_name",
    "bakery_name",
    "product_name",
    "person_name",
    "profile_name",
    "docs_title",
    "latest_item_title",
    "open_role_title",
  ];
  const identityUrlPriority = [
    "company_domain",
    "official_website",
    "official_source_url",
    "profile_url",
    "linkedin_url",
    "product_url",
    "website_url",
    "docs_url",
    "careers_page_url",
    "quote_page_url",
    "menu_url",
    "pricing_page_url",
  ];

  const prioritizedIdentityColumn = identityPriority.find((columnName) =>
    requestedColumns.includes(columnName)
  );
  if (prioritizedIdentityColumn) {
    return [prioritizedIdentityColumn];
  }

  const nameColumn = requestedColumns.find((columnName) =>
    /(^|_)name$/.test(columnName)
  );
  if (nameColumn) {
    return [nameColumn];
  }

  const titleColumn = requestedColumns.find((columnName) =>
    /(^|_)title$/.test(columnName)
  );
  if (titleColumn) {
    return [titleColumn];
  }

  const identityUrlColumn = identityUrlPriority.find((columnName) =>
    requestedColumns.includes(columnName)
  );
  if (identityUrlColumn) {
    return [identityUrlColumn];
  }

  const fallbackIdentityColumn = requestedColumns.find(
    (columnName) =>
      columnName !== "source_url" &&
      !columnName.endsWith("_at") &&
      !columnName.includes("score") &&
      !columnName.startsWith("is_") &&
      !columnName.startsWith("has_")
  );

  return fallbackIdentityColumn ? [fallbackIdentityColumn] : [];
}

export function isUrlColumn(columnName: string): boolean {
  const normalizedColumnName = columnName.toLowerCase();
  return (
    normalizedColumnName === "source_url" ||
    normalizedColumnName.endsWith("_url") ||
    normalizedColumnName.endsWith("_website") ||
    normalizedColumnName === "official_website" ||
    normalizedColumnName === "company_website" ||
    normalizedColumnName === "website_or_menu_url"
  );
}

function isIdentityColumn(columnName: string): boolean {
  return [
    "entity_name",
    "company_name",
    "organization_name",
    "provider_name",
    "restaurant_name",
    "store_name",
    "business_name",
    "bakery_name",
    "product_name",
    "person_name",
    "profile_name",
  ].includes(columnName);
}

function inferEntityNameFromPromptAndSourceUrls(input: {
  prompt: string;
  sourceUrls: string[];
}): string | undefined {
  const sourceText = input.sourceUrls
    .map((sourceUrl) => sourceUrlText(sourceUrl))
    .join(" ");
  const matchingCandidates = entityCandidatesFromPrompt(input.prompt).filter(
    (candidate) => entityCandidateMatchesSource(candidate, sourceText)
  );
  const uniqueMatches = uniqueStrings(matchingCandidates);

  return uniqueMatches.length === 1 ? uniqueMatches[0] : undefined;
}

function sourceUrlText(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    return `${url.hostname} ${url.pathname}`;
  } catch {
    return sourceUrl;
  }
}

export function entityCandidatesFromPrompt(prompt: string): string[] {
  const candidates: string[] = [];
  const entityPattern =
    /\b[A-Z][A-Za-z0-9&.-]*(?:\s+[A-Z][A-Za-z0-9&.-]*){0,3}/g;

  for (const match of prompt.matchAll(entityPattern)) {
    const candidate = trimEntityCandidate(match[0]);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return uniqueStrings(candidates);
}

function trimEntityCandidate(candidate: string): string | undefined {
  const stopWords = new Set([
    "a",
    "an",
    "and",
    "can",
    "for",
    "from",
    "i",
    "in",
    "of",
    "or",
    "the",
    "to",
    "url",
    "with",
  ]);
  const words = candidate.split(/\s+/).filter(Boolean);

  while (words.length > 0 && stopWords.has(words[0].toLowerCase())) {
    words.shift();
  }
  while (
    words.length > 0 &&
    stopWords.has(words[words.length - 1].toLowerCase())
  ) {
    words.pop();
  }

  const trimmedCandidate = words.join(" ").trim();
  return trimmedCandidate.length >= 2 ? trimmedCandidate : undefined;
}

export function entityCandidateMatchesSource(
  candidate: string,
  sourceText: string
): boolean {
  const normalizedSourceText = normalizeIdentityText(sourceText);
  const candidateTokens = candidate
    .split(/\s+/)
    .map(normalizeIdentityText)
    .filter((token) => token.length > 1);
  const compactCandidate = candidateTokens.join("");

  return (
    compactCandidate.length > 1 &&
    (normalizedSourceText.includes(compactCandidate) ||
      candidateTokens.every((token) => normalizedSourceText.includes(token)))
  );
}

export function normalizeIdentityText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeUsage(value: unknown): DatasetAgentUsage {
  const usage = isRecord(value) ? value : {};
  const promptTokens = numberValue(
    usage.promptTokens ?? usage.inputTokens ?? usage.prompt_tokens
  );
  const completionTokens = numberValue(
    usage.completionTokens ?? usage.outputTokens ?? usage.completion_tokens
  );
  return {
    promptTokens,
    completionTokens,
    totalTokens:
      numberValue(usage.totalTokens ?? usage.total_tokens) ||
      promptTokens + completionTokens,
  };
}

function normalizeMetrics(value: unknown): DatasetAgentMetrics {
  const metrics = isRecord(value) ? value : {};
  return {
    searchCalls: numberValue(metrics.searchCalls ?? metrics.searchCallCount),
    fetchCalls: numberValue(metrics.fetchCalls ?? metrics.fetchCallCount),
    browserCalls: numberValue(metrics.browserCalls ?? metrics.browserCallCount),
    agentRuns: numberValue(metrics.agentRuns ?? metrics.agentRunCount),
    agentSteps: numberValue(metrics.agentSteps ?? metrics.agentStepCount),
  };
}

function extractFirstJsonObject(value: string): string | null {
  const firstBraceIndex = value.indexOf("{");
  if (firstBraceIndex === -1) {
    return null;
  }

  let depth = 0;
  let isInsideString = false;
  let isEscaped = false;

  for (let index = firstBraceIndex; index < value.length; index += 1) {
    const character = value[index];
    if (isInsideString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (character === "\\") {
        isEscaped = true;
      } else if (character === "\"") {
        isInsideString = false;
      }
      continue;
    }
    if (character === "\"") {
      isInsideString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(firstBraceIndex, index + 1);
      }
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return typeof value === "string" ? [value] : [];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function singleStringArray(value: unknown): string[] {
  return typeof value === "string" ? [value] : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function isNotNull<T>(value: T | null): value is T {
  return value !== null;
}
