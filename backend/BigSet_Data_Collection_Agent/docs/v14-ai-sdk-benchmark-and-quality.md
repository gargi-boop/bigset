# v1.4: AI SDK integration, benchmark parity, and extraction quality

v1.4 builds on [v1.3 selective results & refresh](v13-selective-results-and-refresh.md). The pipeline stages are unchanged; this release focuses on **how LLM calls are made**, **how runs are measured**, **how benchmark prompts map to CLI runs**, and **fixes that restored reliable row extraction** after the AI SDK migration.

**Next:** [v1.5 efficiency](v15-efficiency-planned.md) (planned) — streaming triage/extract, trimmed memory, outcome-based agents, priority queues, adaptive polling.

---

## 1. Vercel AI SDK + OpenRouter (LLM layer)

### What changed

| Before (v1.3) | v1.4 |
|---------------|------|
| Ad-hoc OpenRouter HTTP / OpenAI-compatible client patterns | Central **`src/llm/`** module |
| Manual JSON parse + Zod validate in places | **`generateText` + `Output.object({ schema })`** in `complete-json.ts` |
| OpenAI-compatible provider shim | **`@openrouter/ai-sdk-provider`** (`provider.ts`) |
| System messages mixed into `messages[]` | Top-level **`system`** option on `generateText` |
| Default temperature on all models | **Temperature omitted by default** (Gemini/reasoning models reject it); optional `OPENROUTER_TEMPERATURE` |

All structured agents still go through `completeJson()` (re-exported from `integrations/openrouter.ts` for backward compatibility):

- Dataset spec, source triage, extraction, extract-from-agent, agent goal, repair diagnosis, repair queries.

### Default model

- **`OPENROUTER_MODEL`** default: `google/gemini-3.1-flash-lite` (updated in config, `.env.example`, and backend `.env` templates).

### Data flow reference

See [data-flow.md](data-flow.md) — **LLM layer** section.

---

## 2. Real token usage (per run)

### What changed

- **`runWithLlmUsageScope`** (`src/llm/usage.ts`) — `AsyncLocalStorage` accumulator for each `generateText` call.
- **`pipeline.ts`** wraps the full run; writes **`llm_usage`** on `run_report.json`:

  ```json
  {
    "prompt_tokens": 327732,
    "completion_tokens": 12931,
    "total_tokens": 340663,
    "call_count": 74
  }
  ```

- **`collection-bridge.ts`** passes real usage into the benchmark JSON contract when `call_count > 0`; falls back to heuristic estimation only when no scoped usage was recorded.

### Why it matters

Benchmark cost reports and CLI runs now reflect **actual** OpenRouter usage instead of row-count guesses.

---

## 3. Benchmark harness alignment

### Collection runtime

- **`DATASET_AGENT_RUNTIME=collection`** → `CollectionPipelineRuntime` (`backend/src/dataset-agent/collection-pipeline-runtime.ts`).
- Runs the same `runPipeline()` as the CLI; maps results via **`collection-bridge.ts`** to the harness row/evidence/usage contract.

### Benchmark-required columns

- **`benchmark-spec.ts`** — `mergeSpecWithBenchmarkRequiredColumns()`:
  - Ensures every `requiredColumns` name from `prompts.json` exists on the spec as **required**.
  - Sets a single **`dedupe_keys`** entry (entity-like column preferred).
  - Appends benchmark extraction hints and `expectedStress` to `extraction_hints`.

### CLI parity flags (new)

```bash
npm run collect -- run \
  -p "..." \
  -t 8 \
  --no-repair \
  --required-columns entity_name,pricing_page_url,plan_or_price,source_url \
  --expected-stress "Official pricing evidence; ..."
```

- **`--required-columns`** — comma-separated; same merge as benchmark.
- **`--expected-stress`** — optional; passed into benchmark spec context.

### Batch CLI for all 16 prompts

| Script | Purpose |
|--------|---------|
| `npm run collect:benchmark` | Run every `prompts.json` entry; agent **on**; artifacts under `runs/benchmark-cli/` |
| `benchmarks/dataset-agent/cli-prompts.sh` | Generated shell reference (regenerated on each `collect:benchmark`, including `--dry-run`) |
| [CLI_BENCHMARK.md](../../../benchmarks/dataset-agent/CLI_BENCHMARK.md) | Operator guide |

Benchmark adapter still writes only **`stdout` / `stderr` / `parsed-output.json`** under `benchmark-results/`; full `run_report.json` requires CLI or `collect:benchmark`.

### Fair comparison notes

Documented in [data-flow.md](data-flow.md) — **Benchmark vs CLI row counts**:

| Factor | Benchmark default | CLI default |
|--------|-------------------|-------------|
| `targetRows` | 8 (`COLLECTION_AGENT_TARGET_ROWS`) | 25 (`-t`) |
| Repair | off | on |
| Artifacts | JSON only in results dir | `runs/<id>/` full tree |

Use matching flags and `--required-columns` for apples-to-apples quality checks.

---

## 4. Schema and extraction quality fixes

These fixes address the main **performance regression** after the AI SDK migration (e.g. many `records_from_extract` but **`records_after_merge: 0`** because `row: {}`).

### Single primary dedupe key

- **`dedupe_keys`** schema enforces **exactly one** column (`schemas.ts` preprocess + dataset-spec prompts).
- Merge identity: `canonicalRecordId` → `pk:{normalized_primary}`.

### Per-spec structured extraction schema

- **`buildLlmExtractionResultSchema(spec)`** — row is `z.object({ column_name: … })` per dataset columns, not `z.record()`.
- AI SDK `Output.object` JSON schema now lists **explicit column keys**, so the model populates `row` instead of putting values only in `evidence`.

### Post-processing (unchanged contract, clearer split)

- LLM returns **`row`**, sparse **`evidence`**, **`extraction_confidence`**.
- **`finalizeExtractedRecord()`** — attaches evidence URLs, `source_urls`; provenance URL fallback only when required column still empty.
- **`hydrateRowFromEvidence()`** — safety net: fills empty row fields from evidence quotes when the model splits data across evidence vs row.

### Repair / triage behavior

- **`knownEntityKeys`** still passed into triage during repair for duplicate detection.
- Triage prompt: mark **`duplicate`** only when no new primary keys are possible on the page.

---

## 5. Tinyfish Agent reliability

| Item | v1.4 behavior |
|------|----------------|
| Execution model | Queue via `/run-async`, parallel poll (`runTinyfishAgentsBatch`) — same as late v1.3 |
| Timeout | `AGENT_POLL_TIMEOUT_MS` default **20 minutes** |
| Cancel on timeout | **`POST /v1/runs/{id}/cancel`** before reporting `TIMEOUT` (`tinyfish-agent.ts`) |
| Poll interval | **3s** default (`AGENT_POLL_INTERVAL_MS`) — unchanged |

---

## 6. Documentation and operator entry points

| Doc | Updates |
|-----|---------|
| [architecture.md](architecture.md) | v1.4 header, AI SDK in services table |
| [data-flow.md](data-flow.md) | LLM layer, benchmark vs CLI, `llm_usage` |
| [AGENTS.md](AGENTS.md) | Doc map |
| [README.md](../README.md) | `collect`, `collect:benchmark` |
| [benchmarks/dataset-agent/README.md](../../../benchmarks/dataset-agent/README.md) | CLI full-artifacts section |

---

## 7. Tests added or extended

Under `backend/test/`:

- `llm-usage.test.ts` — usage scope accumulation
- `collection-bridge.test.ts` — real usage passthrough
- `benchmark-spec.test.ts` — required columns merge, `parseRequiredColumns`
- `extract-page.test.ts` — provenance, evidence hydration

---

## Mapping: v1.3 → v1.4

| Area | v1.3 | v1.4 |
|------|------|------|
| LLM transport | Mixed / legacy OpenRouter usage | Vercel AI SDK + official OpenRouter provider |
| Token metrics | Heuristic in benchmark bridge | Per-run `llm_usage` + bridge passthrough |
| Benchmark ↔ CLI | Adapter only; different defaults | `--required-columns`, `collect:benchmark`, docs for fair compare |
| `dedupe_keys` | Could be multiple | **Single** primary key |
| Extraction structured output | Generic record shape risk | Per-spec column object + evidence hydration |
| Agent timeout | Long poll | Cancel on timeout |
| Package / CLI version | 1.3.0 | **1.4.0** |

---

## Configuration (new or notable)

```env
OPENROUTER_MODEL=google/gemini-3.1-flash-lite
# Optional — only if model supports temperature:
# OPENROUTER_TEMPERATURE=0.2

# Benchmark adapter (backend/.env)
COLLECTION_AGENT_TARGET_ROWS=8
COLLECTION_AGENT_ENABLE_REPAIR=false
DATASET_AGENT_RUNTIME=collection
```

---

## Known limitations (carried into v1.5)

- Triage and extraction remain **sequential phases** (all triage, then extract) — wall-clock not yet optimized.
- **`memoryContextForAgents()`** is identical for every agent — can be large on mature prompts.
- Agents are scheduled from **triage status**, not post-extract coverage.
- Fetch ranking uses memory; **process order** does not yet prioritize by triage confidence.
- Benchmark runs do not persist pipeline artifacts unless using CLI/`collect:benchmark`.

See [v15-efficiency-planned.md](v15-efficiency-planned.md) for the planned efficiency workstream.
