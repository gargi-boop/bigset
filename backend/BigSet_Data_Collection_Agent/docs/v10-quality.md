# v1.0: Data quality & confidence

v1.0 adds **record-level quality scoring** and **unified source outcome tracking** without a separate LLM “quality agent” pass. Instead:

- **Source Triage** reports `source_data_confidence` and `expected_yield` per page.
- **Extract agents** report `extraction_confidence` per record.
- **Coverage analysis** counts complete vs partial rows for repair planning.
- **Deterministic scorer** (`src/quality/`) combines these signals after merge.

## Record classifications

Each merged record gets a `RecordQuality` entry in `quality_report.json`:

| Field | Meaning |
|-------|---------|
| `record_status` | `complete` \| `partial` \| `low_confidence` |
| `needs_review` | `true` when partial, low confidence, or below review threshold |
| `completeness_pct` | Share of required columns filled |
| `confidence_score` | Composite 0–1 score |
| `missing_required_fields` | Required columns still empty |
| `review_reasons` | Human-readable flags |

**Buckets (mutually exclusive primary status):**

- **Complete** — all required fields present, confidence and evidence pass thresholds.
- **Partial** — at least one missing required field.
- **Low confidence** — required fields present but composite score or evidence coverage is weak.

**Needs review** — overlap bucket: any record flagged for human review (includes most partial and low-confidence rows).

## Source outcomes

`sources_outcomes.json` lists every processed URL with an outcome:

| Outcome | Meaning |
|---------|---------|
| `success` | Fetch OK and records extracted (or extract_now path) |
| `fetch_failed` | Tinyfish fetch error |
| `skipped` | Triage: irrelevant, duplicate, blocked, low_value |
| `agent_failed` | Tinyfish Agent error or timeout |
| `agent_deferred` | Over `MAX_AGENT_RUNS_PER_PHASE` budget |
| `no_records` | Processed but zero rows extracted |

`run_report.json` includes `quality` and `sources` summaries.

## Artifacts

| File | Description |
|------|-------------|
| `quality_report.json` | Per-record scores + bucket counts |
| `sources_outcomes.json` | All source URLs with outcomes |
| `records_complete.csv` | Complete records only |
| `records_partial.csv` | Partial records |
| `records_low_confidence.csv` | Low-confidence records |
| `records_needing_review.csv` | Records flagged for review |
| `records_unkeyed.jsonl` | Rows dropped at merge (no dedupe key) |
| `results.csv` | Final dataset + quality columns |
| `evidence.jsonl` | Evidence + embedded `quality` per row |

## Configuration

```env
ENABLE_QUALITY_SCORING=true
QUALITY_LOW_CONFIDENCE_THRESHOLD=0.55
QUALITY_REVIEW_THRESHOLD=0.75
QUALITY_SOURCE_CONFIDENCE_THRESHOLD=0.5
QUALITY_EXTRACTION_CONFIDENCE_THRESHOLD=0.6
```

## Scoring formula (composite)

```
confidence_score =
  0.35 × completeness_pct
+ 0.25 × min(source_data_confidence per source URL)
+ 0.25 × extraction_confidence (default 0.85 if absent)
+ 0.15 × evidence coverage ratio
```

Tune thresholds in `.env` for stricter or looser review queues.
