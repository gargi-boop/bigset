import type { DatasetSpec, ExtractedRecord } from "../models/schemas.js";

function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim().toLowerCase();
}

/** Normalize entity names for stable primary-key matching. */
export function normalizePrimaryKey(value: unknown): string {
  return normalizeValue(value)
    .replace(/\s+/g, " ")
    .replace(/[''`]/g, "'");
}

export function recordDedupeKey(
  record: ExtractedRecord,
  keys: string[],
): string {
  return keys.map((key) => normalizeValue(record.row[key])).join("||");
}

function isEmptyCompositeKey(key: string, keyCount: number): boolean {
  return !key || key === Array.from({ length: keyCount }, () => "").join("||");
}

/**
 * Primary identity column: first dedupe key, or first column whose name suggests a name/title.
 */
export function getPrimaryKeyColumn(spec: DatasetSpec): string | null {
  if (spec.dedupe_keys.length > 0) {
    return spec.dedupe_keys[0]!;
  }

  const nameLike = spec.columns.find((col) =>
    /(name|title|company|organization|entity)/i.test(col.name),
  );
  return nameLike?.name ?? spec.columns[0]?.name ?? null;
}

export function getPrimaryKeyValue(
  record: ExtractedRecord,
  spec: DatasetSpec,
): string {
  const column = getPrimaryKeyColumn(spec);
  if (!column) return "";
  return normalizePrimaryKey(record.row[column]);
}

/**
 * Canonical row id: primary key when present, otherwise full composite dedupe key.
 */
export function canonicalRecordId(
  record: ExtractedRecord,
  spec: DatasetSpec,
): string | null {
  const primary = getPrimaryKeyValue(record, spec);
  if (primary) {
    return `pk:${primary}`;
  }

  const composite = recordDedupeKey(record, spec.dedupe_keys);
  if (!isEmptyCompositeKey(composite, spec.dedupe_keys.length)) {
    return `dk:${composite}`;
  }

  return null;
}

export interface MergeResult {
  records: ExtractedRecord[];
  unkeyed: ExtractedRecord[];
}

export function mergeRecords(
  spec: DatasetSpec,
  records: ExtractedRecord[],
): MergeResult {
  const seen = new Map<string, ExtractedRecord>();
  const unkeyed: ExtractedRecord[] = [];

  for (const record of records) {
    const id = canonicalRecordId(record, spec);
    if (!id) {
      unkeyed.push(record);
      continue;
    }

    const existing = seen.get(id);
    if (!existing) {
      seen.set(id, record);
      continue;
    }

    seen.set(id, mergePair(existing, record, spec));
  }

  return { records: [...seen.values()], unkeyed };
}

/**
 * Merge repair-pass rows into an existing dataset.
 * Rows with the same primary key (e.g. restaurant name) update in place; new keys add rows.
 */
export function mergeRepairIntoExisting(
  spec: DatasetSpec,
  existing: ExtractedRecord[],
  repairRecords: ExtractedRecord[],
): MergeResult {
  return mergeRecords(spec, [...existing, ...repairRecords]);
}

export function mergePair(
  a: ExtractedRecord,
  b: ExtractedRecord,
  spec: DatasetSpec,
): ExtractedRecord {
  const row: Record<string, string | number | boolean | null> = { ...a.row };

  for (const col of spec.columns) {
    const current = row[col.name];
    const incoming = b.row[col.name];
    const currentEmpty =
      current === null || current === undefined || current === "";
    const incomingFilled =
      incoming !== null && incoming !== undefined && incoming !== "";

    if (currentEmpty && incomingFilled) {
      row[col.name] = incoming ?? null;
    }
  }

  const evidence = [...a.evidence];
  const evidenceFields = new Set(evidence.map((e) => e.field));
  for (const item of b.evidence) {
    if (!evidenceFields.has(item.field)) {
      evidence.push(item);
    }
  }

  const extractionConfidence = Math.max(
    a.extraction_confidence ?? 0,
    b.extraction_confidence ?? 0,
  );

  return {
    row,
    evidence,
    source_urls: [...new Set([...a.source_urls, ...b.source_urls])],
    ...(extractionConfidence > 0
      ? { extraction_confidence: extractionConfidence }
      : {}),
  };
}
