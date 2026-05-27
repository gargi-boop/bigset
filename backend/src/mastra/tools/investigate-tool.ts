import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { buildInvestigateAgent } from "../agents/investigate.js";
import { buildExtractAgent } from "../agents/extract.js";
import type { AuthContext } from "../workflows/populate.js";
import type { PopulateColumn } from "../../pipeline/populate.js";
import { convex, internal } from "../../convex.js";

// ─── Shared types ─────────────────────────────────────────────────────────────

interface RowIndexEntry {
  rowId: string;
  confidence: number;
  /** Column values only — no internal _-prefixed fields. */
  cells: Record<string, unknown>;
}

// ─── Output parsers ───────────────────────────────────────────────────────────

/**
 * Parse LEADS / SOURCE_QUALITY keyword output from the extract agent.
 */
function parseExtractOutput(text: string): {
  leads: string;
  source_quality: string;
} {
  const leadsMatch = text.match(/LEADS:\s*([\s\S]*?)(?=\nSOURCE_QUALITY:|$)/i);
  const sourceMatch = text.match(/SOURCE_QUALITY:\s*([\s\S]*?)$/i);

  return {
    leads: leadsMatch?.[1]?.trim() ?? "",
    source_quality: sourceMatch?.[1]?.trim() ?? "",
  };
}

/**
 * Parse SUMMARY / CLUES / REASON keyword output from the investigate agent.
 */
function parseInvestigateOutput(text: string): {
  findings: string;
  leads: string;
} {
  const summaryMatch = text.match(
    /SUMMARY:\s*([\s\S]*?)(?=\nCLUES:|\nREASON:|$)/i,
  );
  const cluesMatch = text.match(/CLUES:\s*([\s\S]*?)(?=\nREASON:|$)/i);
  const reasonMatch = text.match(/REASON:\s*([\s\S]*?)$/i);

  const findings = [summaryMatch?.[1]?.trim(), reasonMatch?.[1]?.trim()]
    .filter(Boolean)
    .join(" — ");

  return {
    findings: findings || text.slice(0, 300),
    leads: cluesMatch?.[1]?.trim() ?? "",
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function cleanDataKeys(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    cleaned[key.replace(/^["`]+|["`]+$/g, "")] = value;
  }
  return cleaned;
}

function isRowComplete(
  cells: Record<string, unknown>,
  columns: PopulateColumn[],
): boolean {
  return columns.every((col) => {
    const val = cells[col.name];
    return val !== null && val !== undefined && val !== "";
  });
}

// ─── Concurrency limiter ──────────────────────────────────────────────────────

/**
 * Maximum number of investigate_entity agents allowed to run concurrently
 * within one workflow run. Shared across all parallel orchestrator calls via
 * the buildExtractTool closure, preventing combinatorial explosion when the
 * orchestrator emits many parallel investigate_entity calls simultaneously.
 */
const MAX_CONCURRENT_INVESTIGATIONS = 10;

class Semaphore {
  private remaining: number;
  private readonly queue: Array<() => void> = [];

  constructor(max: number) {
    this.remaining = max;
  }

  acquire(): Promise<void> {
    if (this.remaining > 0) {
      this.remaining--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.remaining++;
    }
  }
}

// ─── Per-call tool builders ───────────────────────────────────────────────────

/**
 * Insert or update all entities found across a batch of pages in a single
 * tool call.
 *
 * Deduplication strategy (in priority order):
 * 1. Intra-batch: seenInBatch Set eliminates duplicate primary keys within
 *    the same call (first occurrence wins).
 * 2. Cross-agent (in-flight): pendingInserts Set prevents two concurrent
 *    extract agents from both inserting the same primary key. Because
 *    JavaScript's event loop is single-threaded, the Set check + add is
 *    atomic across concurrent awaits — the second agent sees the key already
 *    claimed and skips to the skipped[] list. No Convex-level changes needed.
 * 3. Existing rows: rowIndex gates insert vs. mergeUpdate (confidence-based).
 *
 * Returns needs_investigation listing every inserted/updated row that still
 * has blank columns — the orchestrator calls investigate_entity for each
 * after all extract_rows calls have completed.
 */
function buildBatchInsertRowsTool(
  rowIndex: Map<string, RowIndexEntry>,
  pendingInserts: Set<string>,
  authorizedDatasetId: string,
  logCtx: string,
  columns: PopulateColumn[],
  primaryKeyColumn: string,
) {
  const columnNames = columns.map((c) => c.name);

  return createTool({
    id: "batch_insert_rows",
    description:
      "Insert or update ALL entities found across the fetched pages in a single call. " +
      "New entities are inserted; entities already present with LOWER confidence are updated " +
      "using per-field merge rules; entities with equal/higher confidence are skipped. " +
      "Duplicate primary keys within the call are deduplicated automatically (first wins). " +
      "Each entry needs primary_key, confidence (0–1: 1.0 = primary source, 0.5 = aggregator, " +
      "0.2 = indirect), sources (column → URL; \"\" if unverifiable), and data (column values; " +
      "\"\" for unverifiable columns). " +
      "Never fabricate values — leave blank instead.",
    inputSchema: z.object({
      rows: z
        .array(
          z.object({
            primary_key: z
              .string()
              .describe(
                `Value of the primary key column "${primaryKeyColumn}" — used for deduplication`,
              ),
            confidence: z
              .number()
              .min(0)
              .max(1)
              .describe(
                "Source confidence 0–1 (1.0 = official primary source, 0.5 = aggregator, 0.2 = indirect mention)",
              ),
            sources: z
              .record(z.string(), z.string())
              .describe(
                'Map of column name → source URL for each column you filled. Use "" for unverifiable columns.',
              ),
            data: z
              .record(z.string(), z.any())
              .describe(
                `Object with exactly these keys: ${JSON.stringify(columnNames)}. Use "" for unverifiable columns.`,
              ),
          }),
        )
        .min(1)
        .describe("Every entity found across all fetched pages — do not omit any"),
    }),
    outputSchema: z.object({
      inserted: z.array(z.string()).describe("Primary keys successfully inserted as new rows"),
      updated: z.array(z.string()).describe("Primary keys updated — existed with lower confidence"),
      skipped: z.array(z.string()).describe("Primary keys skipped — equal/higher confidence already on record, in-flight from a concurrent agent, or duplicate within this call"),
      errors: z
        .array(z.object({ primary_key: z.string(), error: z.string() }))
        .describe("Primary keys that failed, with error messages"),
      needs_investigation: z
        .array(
          z.object({
            primary_key: z.string(),
            blank_columns: z.array(z.string()),
          }),
        )
        .describe(
          "Rows that were inserted or updated but still have blank columns. " +
          "The orchestrator will call investigate_entity for each after all extractions finish.",
        ),
    }),
    execute: async ({ rows }) => {
      const inserted: string[] = [];
      const updated: string[] = [];
      const skipped: string[] = [];
      const errors: Array<{ primary_key: string; error: string }> = [];
      const needs_investigation: Array<{ primary_key: string; blank_columns: string[] }> = [];

      // Intra-batch dedup: first occurrence of each primary key wins.
      const seenInBatch = new Set<string>();

      for (const row of rows) {
        const { primary_key, confidence, sources, data } = row;

        // 1. Intra-batch dedup
        if (seenInBatch.has(primary_key)) {
          skipped.push(primary_key);
          continue;
        }
        seenInBatch.add(primary_key);

        if (!data || Object.keys(data).length === 0) {
          errors.push({ primary_key, error: "data is required" });
          continue;
        }

        const cleanedData = cleanDataKeys(data);
        const existingEntry = rowIndex.get(primary_key);

        if (existingEntry) {
          // ── Update path: row already exists ────────────────────────────────
          if (confidence <= existingEntry.confidence) {
            // Equal or higher confidence already on record — nothing to do.
            skipped.push(primary_key);
            continue;
          }

          console.log(
            `[batch_insert_rows] ${logCtx} pk="${primary_key}" updating ` +
              `(confidence ${existingEntry.confidence.toFixed(2)}→${confidence.toFixed(2)})`,
          );
          try {
            await convex.mutation(internal.datasetRows.mergeUpdate, {
              id: existingEntry.rowId as any,
              expectedDatasetId: authorizedDatasetId,
              newData: cleanedData,
              newConfidence: confidence,
              newSources: sources,
            });

            // Mirror the per-field merge in the local rowIndex.
            const updatedCells: Record<string, unknown> = { ...existingEntry.cells };
            for (const [col, val] of Object.entries(cleanedData)) {
              if (col.startsWith("_")) continue;
              if (val === null || val === undefined || val === "") continue;
              const existingVal = updatedCells[col];
              const existingIsBlank =
                existingVal === null || existingVal === undefined || existingVal === "";
              if (existingIsBlank || confidence > existingEntry.confidence) {
                updatedCells[col] = val;
              }
            }
            rowIndex.set(primary_key, {
              rowId: existingEntry.rowId,
              confidence: Math.max(existingEntry.confidence, confidence),
              cells: updatedCells,
            });

            updated.push(primary_key);

            const blank_columns = columns
              .filter((col) => {
                const v = updatedCells[col.name];
                return v === null || v === undefined || v === "";
              })
              .map((col) => col.name);
            if (blank_columns.length > 0) {
              needs_investigation.push({ primary_key, blank_columns });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `[batch_insert_rows] Update failed: ${logCtx} pk="${primary_key}" err=${msg}`,
            );
            errors.push({ primary_key, error: `Update failed: ${msg}` });
          }
          continue;
        }

        // ── Insert path: new row ──────────────────────────────────────────────
        // 2. Cross-agent dedup via pendingInserts.
        // The check + add is synchronous before any await — atomic in JS's
        // single-threaded event loop. A second concurrent agent seeing this key
        // in pendingInserts goes to skipped[]; it will appear in list_rows
        // after the first agent's insert completes, and the orchestrator will
        // spawn an investigate_entity for it if it has blank columns.
        if (pendingInserts.has(primary_key)) {
          skipped.push(primary_key);
          continue;
        }
        pendingInserts.add(primary_key);

        const sourceUrls = Array.from(new Set(Object.values(sources).filter(Boolean)));
        const enrichedData: Record<string, unknown> = {
          ...cleanedData,
          _confidence: confidence,
          _sources: sources,
        };

        try {
          const rowId = await convex.mutation(internal.datasetRows.insert, {
            datasetId: authorizedDatasetId,
            data: enrichedData,
            sources: sourceUrls,
          });

          const cells: Record<string, unknown> = {};
          for (const col of columns) cells[col.name] = cleanedData[col.name] ?? "";
          rowIndex.set(primary_key, { rowId: rowId as string, confidence, cells });
          inserted.push(primary_key);

          const blank_columns = columns
            .filter((col) => {
              const v = cells[col.name];
              return v === null || v === undefined || v === "";
            })
            .map((col) => col.name);
          if (blank_columns.length > 0) {
            needs_investigation.push({ primary_key, blank_columns });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(
            `[batch_insert_rows] Insert failed: ${logCtx} pk="${primary_key}" err=${msg}`,
          );
          if (msg.includes("Quota") || msg.includes("quota")) {
            errors.push({
              primary_key,
              error: `Quota exceeded: ${msg}. Stop inserting rows for this billing period.`,
            });
            pendingInserts.delete(primary_key);
            break;
          }
          if (msg.includes("validator")) {
            errors.push({
              primary_key,
              error: `Validation failed: ${msg}. Check that column keys are plain strings.`,
            });
          } else {
            errors.push({ primary_key, error: `Insert failed: ${msg}` });
          }
        } finally {
          pendingInserts.delete(primary_key);
        }
      }

      console.log(
        `[batch_insert_rows] ${logCtx} inserted=${inserted.length} updated=${updated.length} ` +
          `skipped=${skipped.length} errors=${errors.length} needs_investigation=${needs_investigation.length}`,
      );
      return { inserted, updated, skipped, errors, needs_investigation };
    },
  });
}

function buildUpdateRowByKeyTool(
  rowIndex: Map<string, RowIndexEntry>,
  authorizedDatasetId: string,
  logCtx: string,
  columns: PopulateColumn[],
) {
  return createTool({
    id: "update_row_by_key",
    description:
      "Update an existing row identified by its primary key value using per-field merge rules: " +
      "blank cells are always filled with your non-empty values regardless of confidence; " +
      "non-blank cells are only overwritten when your confidence is strictly higher than the " +
      "row's existing confidence. Empty strings in data are always skipped. " +
      "Returns skipped: true when no field satisfied the merge rules (a no-op, not an error). " +
      "Provide source URLs for each column you are updating.",
    inputSchema: z.object({
      primary_key: z
        .string()
        .describe("Primary key value of the row to update"),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .describe("Your source confidence 0–1 (1.0 = official primary source, 0.5 = aggregator, 0.2 = indirect mention)"),
      data: z
        .record(z.string(), z.any())
        .describe(
          "Column values to merge. Blank cells always accept non-empty values; " +
          "non-blank cells only update when your confidence is higher. Empty strings are skipped.",
        ),
      sources: z
        .record(z.string(), z.string())
        .describe("Column name → source URL for each column you are updating"),
    }),
    outputSchema: z.object({
      success: z.boolean(),
      skipped: z.boolean().optional(),
      error: z.string().optional(),
    }),
    execute: async ({ primary_key, confidence, data, sources }) => {
      const existing = rowIndex.get(primary_key);
      if (!existing) {
        return {
          success: false,
          error: `"${primary_key}" not found. Use batch_insert_rows for new entities.`,
        };
      }

      const cleanedNew = cleanDataKeys(data);
      console.log(
        `[update_row_by_key] ${logCtx} pk="${primary_key}" ` +
          `attempting merge at confidence=${confidence.toFixed(2)} (existing=${existing.confidence.toFixed(2)})`,
      );

      try {
        // mergeUpdate atomically reads the current committed row, applies
        // per-field blank-aware merge rules, and writes — eliminating the
        // race window that existed when the confidence check happened here
        // against a stale in-memory rowIndex.
        const result = await convex.mutation(internal.datasetRows.mergeUpdate, {
          id: existing.rowId as any,
          expectedDatasetId: authorizedDatasetId,
          newData: cleanedNew,
          newConfidence: confidence,
          newSources: sources,
        });

        if (!result.merged) {
          console.log(
            `[update_row_by_key] ${logCtx} pk="${primary_key}" no-op (no fields changed)`,
          );
          return { success: true, skipped: true };
        }

        // Mirror the same per-field merge logic in the local rowIndex so
        // subsequent calls within this run see a consistent view without
        // a Convex round-trip.
        const updatedCells: Record<string, unknown> = { ...existing.cells };
        for (const [col, val] of Object.entries(cleanedNew)) {
          if (col.startsWith("_")) continue;
          if (val === null || val === undefined || val === "") continue;
          const existingVal = updatedCells[col];
          const existingIsBlank =
            existingVal === null || existingVal === undefined || existingVal === "";
          if (existingIsBlank || confidence > existing.confidence) {
            updatedCells[col] = val;
          }
        }

        rowIndex.set(primary_key, {
          rowId: existing.rowId,
          confidence: Math.max(existing.confidence, confidence),
          cells: updatedCells,
        });

        console.log(
          `[update_row_by_key] ${logCtx} pk="${primary_key}" merged ok`,
        );
        return { success: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[update_row_by_key] Failed: ${logCtx} pk="${primary_key}" err=${msg}`,
        );
        if (msg.includes("Row not found") || msg.includes("not found"))
          return {
            success: false,
            error: "Row no longer exists — it may have been deleted.",
          };
        return { success: false, error: `Update failed: ${msg}` };
      }
    },
  });
}

// ─── Main tool factory ────────────────────────────────────────────────────────

/**
 * Build the extract_rows, list_rows, and investigate_entity tools scoped to
 * one dataset and workflow run.
 *
 * All three tools share a single in-memory rowIndex (Map of primary-key →
 * {rowId, confidence, cells}) that serves as the canonical state for the run.
 *
 * extract_rows:
 *   Dispatches a batch of 1–5 URLs to a fresh extract agent. The agent
 *   fetches all pages in parallel, extracts all matching entities, and calls
 *   batch_insert_rows once with everything combined. Returns leads for the
 *   orchestrator's next search round. Multiple extract_rows calls run in
 *   parallel from the orchestrator.
 *
 * list_rows:
 *   Returns a compact text summary of all rows — complete, incomplete, and
 *   their confidence levels. Called by the orchestrator after each round of
 *   extract_rows calls to decide what to investigate and whether to stop.
 *
 * investigate_entity:
 *   Spawned directly by the orchestrator (not by extract agents) after
 *   list_rows reveals incomplete rows. Closes over the shared rowIndex and
 *   investigateSemaphore. Each invocation spawns a fresh investigate agent
 *   that searches the web and fills missing columns via update_row_by_key.
 *   A global Semaphore(10) caps concurrent investigate agents.
 *
 * pendingInserts:
 *   A Set shared across all parallel batch_insert_rows calls. Prevents two
 *   concurrent extract agents from both inserting the same primary key. The
 *   check + add is synchronous before any await — atomic in JS's
 *   single-threaded event loop.
 *
 * A fresh call to buildExtractTool per workflow run is required — do not
 * cache the returned tools across runs.
 */
export function buildExtractTool(
  authorizedDatasetId: string,
  authContext: AuthContext,
  columns: PopulateColumn[],
  targetRows: number = 20,
): {
  extractRowsTool: ReturnType<typeof createTool>;
  listRowsTool: ReturnType<typeof createTool>;
  investigateEntityTool: ReturnType<typeof createTool>;
} {
  const primaryKeyColumn = columns[0]?.name ?? "";
  const columnNames = columns.map((c) => c.name);
  const logCtx = `user=${authContext.authorizedUserId} run=${authContext.workflowRunId} dataset=${authorizedDatasetId}`;

  // Shared mutable state for this workflow run.
  const rowIndex = new Map<string, RowIndexEntry>();

  // Prevents concurrent extract agents from double-inserting the same entity.
  const pendingInserts = new Set<string>();

  // Caps total concurrent investigate_entity agents across the whole run.
  const investigateSemaphore = new Semaphore(MAX_CONCURRENT_INVESTIGATIONS);

  function countCompleteRows(): number {
    let n = 0;
    for (const { cells } of rowIndex.values()) {
      if (isRowComplete(cells, columns)) n++;
    }
    return n;
  }

  function buildExistingRowsText(): string {
    if (rowIndex.size === 0) return "None yet.";
    const lines: string[] = [];
    for (const [pk, { cells, confidence }] of rowIndex.entries()) {
      const missing = columns
        .filter((c) => !cells[c.name] && cells[c.name] !== 0)
        .map((c) => c.name);
      const status =
        missing.length === 0
          ? "[COMPLETE]"
          : `[INCOMPLETE — missing: ${missing.join(", ")}]`;
      const cellPairs = columnNames
        .map((n) => `${n}: ${JSON.stringify(cells[n] ?? "")}`)
        .join(", ");
      lines.push(
        `• "${pk}" | ${cellPairs} | confidence ${confidence.toFixed(2)} ${status}`,
      );
    }
    return lines.join("\n");
  }

  // ── investigate_entity tool ─────────────────────────────────────────────────
  // Exposed directly to the orchestrator. Called after all extract_rows have
  // finished and list_rows has identified which rows are incomplete.

  const investigateEntityTool = createTool({
    id: "investigate_entity",
    description:
      "Spawn an investigation agent to research a specific entity and fill its missing columns " +
      "via web search and page fetching. " +
      "Call this for every INCOMPLETE row shown in list_rows after all extract_rows have finished. " +
      "Emit ALL investigate_entity calls simultaneously in one response — do not wait for one " +
      "to finish before calling the next; they run in parallel. " +
      "Provide the primary key, the missing column names, and all context you have " +
      "(partial data from list_rows, relevant leads from extract_rows results).",
    inputSchema: z.object({
      primary_key: z
        .string()
        .describe("Primary key value of the row to investigate"),
      missing_columns: z
        .array(z.string())
        .describe("Column names that are blank — the agent's priority targets"),
      context: z
        .string()
        .describe(
          "Everything known about this entity: partial data from list_rows, " +
            "relevant leads or URLs from extract_rows results, any useful search hints",
        ),
    }),
    outputSchema: z.object({
      findings: z.string(),
      leads: z.string(),
    }),
    execute: async ({ primary_key, missing_columns, context }) => {
      const existing = rowIndex.get(primary_key);
      if (!existing) {
        return {
          findings: `Row "${primary_key}" not found in dataset — cannot investigate.`,
          leads: "",
        };
      }

      // Fast-path: if the row is already complete per the in-memory index,
      // skip without spawning an agent. Handles races where a parallel
      // investigate_entity already filled this row.
      if (isRowComplete(existing.cells, columns)) {
        console.log(
          `[investigate_entity] ${logCtx} pk="${primary_key}" already complete — skipping`,
        );
        return { findings: "Row already complete — skipped", leads: "" };
      }

      const existingDataText = columnNames
        .map(
          (n) =>
            `${n}: ${JSON.stringify(existing.cells[n] ?? "")}${!existing.cells[n] && existing.cells[n] !== 0 ? " [MISSING]" : ""}`,
        )
        .join(", ");

      console.log(
        `[investigate_entity] ${logCtx} pk="${primary_key}" missing=${missing_columns.join(",")}`,
      );

      const updateTool = buildUpdateRowByKeyTool(
        rowIndex,
        authorizedDatasetId,
        `${logCtx} investigate="${primary_key}"`,
        columns,
      );
      const agent = buildInvestigateAgent(columns, primaryKeyColumn, updateTool);

      const prompt =
        `Research this entity: "${primary_key}"\n\n` +
        `Currently known data: ${existingDataText}\n` +
        `Missing columns to fill (priority): ${missing_columns.join(", ")}\n\n` +
        `Context:\n${context}`;

      await investigateSemaphore.acquire();
      try {
        const result = await agent.generate(prompt, { maxSteps: 20 });
        const parsed = parseInvestigateOutput(result.text);

        console.log(
          `[investigate_entity] done ${logCtx} pk="${primary_key}" steps=${result.steps?.length ?? "?"}`,
        );

        return { findings: parsed.findings, leads: parsed.leads };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[investigate_entity] error ${logCtx} pk="${primary_key}" err=${msg}`,
        );
        return {
          findings: `Investigation failed: ${msg}`,
          leads: "",
        };
      } finally {
        investigateSemaphore.release();
      }
    },
  });

  // ── list_rows tool ──────────────────────────────────────────────────────────

  const listRowsTool = createTool({
    id: "list_rows",
    description:
      "Get a compact summary of all rows currently in the dataset — which are complete, " +
      "which have missing columns, and their confidence levels. " +
      "Call this once after all extract_rows calls have finished. " +
      "Use the output to spawn investigate_entity for every INCOMPLETE row, " +
      "and to decide whether the stop conditions have been met.",
    inputSchema: z.object({}),
    outputSchema: z.object({ summary: z.string() }),
    execute: async () => {
      const complete = countCompleteRows();
      const total = rowIndex.size;
      if (total === 0) return { summary: "No rows yet." };

      const lines = [
        `${total} rows total (${complete} complete / ${targetRows} target, ${total - complete} incomplete).`,
      ];
      for (const [pk, { cells, confidence }] of rowIndex.entries()) {
        const missing = columns
          .filter((c) => !cells[c.name] && cells[c.name] !== 0)
          .map((c) => c.name);
        const status =
          missing.length === 0
            ? "[COMPLETE]"
            : `[INCOMPLETE — missing: ${missing.join(", ")}]`;
        const preview = columnNames
          .map((n) => `${n}: ${JSON.stringify(cells[n] ?? "")}`)
          .join(", ");
        lines.push(
          `• "${pk}" | ${preview} | confidence ${confidence.toFixed(2)} ${status}`,
        );
      }
      return { summary: lines.join("\n") };
    },
  });

  // ── extract_rows tool ───────────────────────────────────────────────────────

  const extractRowsTool = createTool({
    id: "extract_rows",
    description:
      "Dispatch one source URL to an extraction agent. " +
      "The agent fetches the page, extracts all matching entities, " +
      "and inserts them in a single batch_insert_rows call. " +
      "Returns leads for your next search round. " +
      "Run multiple extract_rows calls in parallel for different URLs — " +
      "wait for ALL to finish before calling list_rows.",
    inputSchema: z.object({
      source_urls: z
        .array(z.string())
        .min(1)
        .max(1)
        .describe(
          "Exactly 1 qualifying URL to process. " +
            "Use title, snippet, and site name to pick the most relevant page.",
        ),
      context: z
        .string()
        .describe(
          "What to extract: entity type, data signals seen in search snippets/titles, " +
            "any partial information already known. The agent has no other context.",
        ),
      notes: z
        .string()
        .optional()
        .describe(
          "Hints from previous extraction results: URL patterns, source types that worked well.",
        ),
    }),
    outputSchema: z.object({
      leads: z.string(),
      source_quality: z.string(),
    }),
    execute: async ({ source_urls, context, notes }) => {
      console.log(
        `[extract_rows] ${logCtx} url=${source_urls[0]} known_rows=${rowIndex.size}`,
      );

      // Hard cap: if target is already reached, skip this batch.
      const completeAtStart = countCompleteRows();
      if (completeAtStart >= targetRows) {
        console.log(
          `[extract_rows] ${logCtx} skipping — target already reached (${completeAtStart}/${targetRows})`,
        );
        return {
          leads: "",
          source_quality: `Target row count (${targetRows}) already reached — skipped.`,
        };
      }

      try {
        // Refresh rowIndex from Convex to pick up rows written by other
        // parallel extract_rows calls or investigate_entity agents since the
        // last refresh. Update EXISTING entries when Convex has higher-confidence
        // data so countCompleteRows() and investigate pre-checks stay accurate.
        const currentRows = await convex.query(
          internal.datasetRows.listInternal,
          { datasetId: authorizedDatasetId },
        );
        for (const row of currentRows) {
          const d = row.data as Record<string, unknown>;
          const pk = String(d[primaryKeyColumn] ?? "");
          if (!pk) continue;
          const convexConfidence =
            typeof d._confidence === "number" ? d._confidence : 0.5;
          const existingEntry = rowIndex.get(pk);
          if (!existingEntry) {
            const cells: Record<string, unknown> = {};
            for (const col of columns) cells[col.name] = d[col.name] ?? "";
            rowIndex.set(pk, {
              rowId: row._id as string,
              confidence: convexConfidence,
              cells,
            });
          } else if (convexConfidence > existingEntry.confidence) {
            const cells: Record<string, unknown> = {};
            for (const col of columns) cells[col.name] = d[col.name] ?? "";
            rowIndex.set(pk, {
              rowId: row._id as string,
              confidence: convexConfidence,
              cells,
            });
          }
        }

        const existingRowsText = buildExistingRowsText();

        // Build a fresh batch_insert_rows tool that shares the run-level
        // rowIndex and pendingInserts closure.
        const batchInsertRowsTool = buildBatchInsertRowsTool(
          rowIndex,
          pendingInserts,
          authorizedDatasetId,
          logCtx,
          columns,
          primaryKeyColumn,
        );

        const notesBlock = notes ? `\nAdditional hints:\n${notes}` : "";
        const prompt =
          `Fetch and extract from this URL: ${source_urls[0]}\n\n` +
          `Context: ${context}${notesBlock}\n\n` +
          `Existing rows in the dataset:\n${existingRowsText}`;

        const agent = buildExtractAgent(
          columns,
          primaryKeyColumn,
          batchInsertRowsTool,
        );

        const result = await agent.generate(prompt, { maxSteps: 40 });
        const parsed = parseExtractOutput(result.text);

        console.log(
          `[extract_rows] done ${logCtx} url=${source_urls[0]} ` +
            `rows=${rowIndex.size} complete=${countCompleteRows()} steps=${result.steps?.length ?? "?"}`,
        );

        return parsed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[extract_rows] error ${logCtx} err=${msg}`);
        return {
          leads: "",
          source_quality: `Extraction agent failed: ${msg}`,
        };
      }
    },
  });

  return { extractRowsTool, listRowsTool, investigateEntityTool };
}
