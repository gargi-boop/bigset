# v1.3: Selective results & recurring refresh

> **Still current for:** selective `results.csv`, refresh CLI, per-field confidence.  
> **LLM transport, benchmark parity, extraction fixes:** see [v1.4](v14-ai-sdk-benchmark-and-quality.md).

## 1. Selective results visualization

### Per-field confidence

During quality scoring, each **populated** column gets a `field_confidences` score (0–1) derived from:

- The **evidence URL** for that field → triage `source_data_confidence` and routing `confidence`
- Row-level `extraction_confidence` from the extract/agent step
- Fallback when evidence is missing (lower score)

The record-level **`confidence_score`** is the mean of **required** field confidences (when any exist).

### Primary outputs

| File | Contents |
|------|----------|
| `results.csv` | Rows with **all required fields** filled, sorted by `completeness_pct` ↓ then `confidence_score` ↓ |
| `results_full.csv` | Full merged dataset (same as before) |
| `evidence.jsonl` | Selective rows + quality metadata |
| `evidence_full.jsonl` | All merged rows |

`results.csv` adds `{required_column}_confidence` columns plus existing quality columns.

Disable selective filter: `ENABLE_SELECTIVE_RESULTS=false` (still writes ranked full set to `results.csv`).

Segmented CSVs (`records_complete.csv`, etc.) still reflect status buckets over the **full** merge.

## 2. Recurring refresh

Re-run acquisition for an existing run using the **same dataset spec** and **workflow memory** (diagnoses, query/domain stats), merging **in place by primary key** — no duplicate entities.

```bash
npm run run -- refresh --from-run abc12345
```

| Flag | Effect |
|------|--------|
| `--from-run <id>` | Load `dataset_spec.json`, `evidence.jsonl`, `workflow_memory.json`, `run_report.json` |
| `--in-place` | Reuse the same `runs/{id}/` folder (default: new run id, `refreshed_from_run_id` in report) |
| `--refetch-urls` | Do not skip URLs already in the source run’s `fetched_urls` |
| `--no-repair` | Skip repair loops after refresh acquisition |

Flow:

1. Baseline records from prior `evidence.jsonl`
2. New search/fetch/extract (`refresh` phase) with memory + prior diagnoses
3. `mergeRepairIntoExisting` — fill empty fields, keep existing values when still set
4. Repair loops if required fields still missing
5. Selective `results.csv` export

Persistent memory at `memory/{fingerprint}.json` is still updated for cross-prompt learning.

## Configuration

```env
ENABLE_SELECTIVE_RESULTS=true
```
