/**
 * extract-tool.ts — builds the `extract_pages` tool for the populate orchestrator.
 *
 * Unlike the investigate agent (which runs a full agent loop per entity),
 * this tool is a lightweight two-step programmatic call:
 *   1. Fetch the given URLs in parallel via executeFetchPage.
 *   2. Call a cheap/fast LLM once per page with generateObject to extract
 *      entities in structured format — no back-and-forth agent loop.
 *
 * Deduplication strategy
 * ─────────────────────
 * The tool maintains a per-run dedup set in its closure. The dedup key is:
 *   - Primary key composite (normalised) when the LLM found primary key values.
 *   - `name:<dedup_hint>` (normalised entity name) as fallback when primary
 *     key values are not visible on the listing page (e.g. when the PK is a
 *     company URL that isn't shown directly on a directory page).
 *
 * This means listing pages that only show company names will still yield
 * one entity per company, correctly deduped, even though the URL primary key
 * is missing. The investigate agent discovers the actual primary key value
 * through research before inserting.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { generateObject } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { executeFetchPage } from "./web-tools.js";
import { env } from "../../env.js";
import type { PopulateColumn } from "../../pipeline/populate.js";

// Per-page extraction output schema.
// primary_keys is intentionally optional — listing pages often show entity
// names/descriptions but not the canonical URL or ID that serves as PK.
// dedup_hint is required so we can always deduplicate on entity name.
const pageExtractionSchema = z.object({
  entities: z
    .array(
      z.object({
        dedup_hint: z
          .string()
          .describe(
            "The entity's name or most unique visible identifier (e.g. company name, person name, product title). Required — used for deduplication when primary key values are not yet known.",
          ),
        primary_keys: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Primary key column values if directly visible on the page. Omit or leave empty if the value isn't shown — the investigate agent will find it.",
          ),
        partial_data: z
          .record(z.string(), z.string())
          .optional()
          .describe("Any other column values visible on the page"),
        hints: z
          .string()
          .optional()
          .describe(
            "Notes on where/how to find missing column values for this entity (e.g. 'check their LinkedIn for email', 'homepage footer has the address')",
          ),
      }),
    )
    .describe("All matching entities found on this page"),
  leads: z
    .array(z.string())
    .describe(
      "URLs from this page likely to contain more matching entities (pagination, related directories, etc.)",
    ),
});

/**
 * Build the extract_pages tool scoped to one dataset schema.
 *
 * @param datasetName  Human-readable dataset name — given to the extract LLM
 * @param description  Dataset description — given to the extract LLM
 * @param columns      Column definitions (must include isPrimaryKey flags)
 *
 * Returns a Mastra tool. Build once per workflow run; do not share across runs
 * (the dedup set is per-run state captured in the closure).
 */
export function buildExtractTool(
  datasetName: string,
  description: string,
  columns: PopulateColumn[],
) {
  const openrouter = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY!,
  });

  const pkColumns = columns.filter((c) => c.isPrimaryKey);
  const columnsDesc = columns
    .map(
      (c) =>
        `- "${c.name}" (${c.type})${c.isPrimaryKey ? " [PRIMARY KEY]" : ""}${c.description ? `: ${c.description}` : ""}`,
    )
    .join("\n");

  // Per-run dedup set. Key is either the primary-key composite (if values
  // were found) or `name:<normalised dedup_hint>` (fallback).
  const dispatchedKeys = new Set<string>();

  function makeEntityKey(
    dedupHint: string,
    primaryKeys?: Record<string, string>,
  ): string {
    // Try to build a key from non-empty primary key values
    if (primaryKeys) {
      const filled = pkColumns
        .map((c) => [c.name, (primaryKeys[c.name] ?? "").toLowerCase().trim()])
        .filter(([, v]) => v !== "");
      if (filled.length > 0) return JSON.stringify(filled);
    }
    // Fall back to normalised entity name
    return `name:${dedupHint.toLowerCase().trim()}`;
  }

  const pkNames = pkColumns.map((c) => `"${c.name}"`).join(", ");
  const systemPrompt = `You extract structured entity data from web pages for a dataset.

Dataset: ${datasetName}${description ? `\nDescription: ${description}` : ""}

Target columns:
${columnsDesc}

For each matching entity on the page:
- ALWAYS fill dedup_hint with the entity's name or most unique visible identifier (e.g. company name). This is required.
- Fill primary_keys (${pkNames}) if the values are directly visible on the page. If not visible, omit them — leave the field out entirely. Do NOT guess or fabricate primary key values.
- Fill partial_data with any other column values visible on the page.
- Fill hints with short notes on where to find missing values for this entity.

Also return leads: URLs from this page likely to contain more matching entities.

Only include entities that genuinely match the dataset topic. Do not fabricate values.`;

  return createTool({
    id: "extract_pages",
    description:
      "Fetch 1–5 web pages and extract all matching dataset entities from them using a fast LLM. Returns structured entity data (primary keys if found, partial column values, dedup hints, hints for missing fields) and leads (URLs with more entities). Only returns entities not yet dispatched to run_subagent.",
    inputSchema: z.object({
      urls: z
        .array(z.string())
        .min(1)
        .max(5)
        .describe("1–5 URLs to fetch and extract entities from"),
    }),
    outputSchema: z.object({
      entities: z.array(
        z.object({
          dedup_hint: z.string(),
          primary_keys: z.record(z.string(), z.string()).optional(),
          partial_data: z.record(z.string(), z.string()).optional(),
          hints: z.string().optional(),
          source_url: z.string(),
        }),
      ),
      leads: z.array(z.string()),
      errors: z.array(z.string()).optional(),
    }),
    execute: async ({ urls }) => {
      console.log(
        `[extract_pages] Fetching ${urls.length} URL(s): ${urls.join(", ")}`,
      );

      // Step 1: fetch all pages in parallel
      const fetched = await Promise.all(
        urls.map(async (url) => ({ url, page: await executeFetchPage(url) })),
      );

      const newEntities: Array<{
        dedup_hint: string;
        primary_keys?: Record<string, string>;
        partial_data?: Record<string, string>;
        hints?: string;
        source_url: string;
      }> = [];
      const allLeads: string[] = [];
      const errors: string[] = [];

      // Step 2: run LLM extraction on each successfully fetched page in parallel
      await Promise.all(
        fetched.map(async ({ url, page }) => {
          if (page.error || !page.text) {
            errors.push(`${url}: ${page.error ?? "no content"}`);
            return;
          }

          try {
            const { object } = await generateObject({
              model: openrouter(env.BIGSET_EXTRACT_MODEL),
              schema: pageExtractionSchema,
              system: systemPrompt,
              prompt: `Page URL: ${url}${page.title ? `\nPage title: ${page.title}` : ""}\n\n${page.text}`,
            });

            let pageNewCount = 0;
            for (const entity of object.entities) {
              // Require at minimum a dedup_hint (entity name)
              if (!entity.dedup_hint?.trim()) continue;

              const key = makeEntityKey(entity.dedup_hint, entity.primary_keys);
              if (!dispatchedKeys.has(key)) {
                dispatchedKeys.add(key);
                newEntities.push({ ...entity, source_url: url });
                pageNewCount++;
              }
            }

            allLeads.push(...object.leads);
            console.log(
              `[extract_pages] ${url}: ${object.entities.length} found, ${pageNewCount} new`,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(
              `[extract_pages] LLM extraction failed for ${url}: ${msg}`,
            );
            errors.push(`${url}: extraction failed`);
          }
        }),
      );

      const dedupedLeads = [...new Set(allLeads)];
      console.log(
        `[extract_pages] Done: ${newEntities.length} new entities total, ${dedupedLeads.length} leads`,
      );
      return {
        entities: newEntities,
        leads: dedupedLeads,
        ...(errors.length > 0 ? { errors } : {}),
      };
    },
  });
}
