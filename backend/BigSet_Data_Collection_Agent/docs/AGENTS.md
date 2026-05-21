# Data Collection Agent — Agent Guidelines

## Fix the architecture, not the symptom

When fixing bugs or implementing requests:

1. **Do not treat a bug report or example input as the full specification.** Treat it as evidence of a broader failure mode. Infer the general class of problem, inspect relevant code paths, and propose fixes that work across varied prompts, schemas, and data shapes.

2. **Avoid hardcoded fixes** that only handle the specific example mentioned (e.g. per-column alias maps, per-prompt special cases).

3. **Inspect existing implementation first.** Do not add a new wrapper, post-processing layer, or special case unless the issue belongs in an existing function, data model, or pipeline stage.

4. **Prefer modifying the source of truth** over corrective code after the fact.

## Documentation map

| Doc | Contents |
|-----|----------|
| [architecture.md](architecture.md) | Pipeline stages, services, limits |
| [data-flow.md](data-flow.md) | Types passed between stages with JSON examples |
| [v13-selective-results-and-refresh.md](v13-selective-results-and-refresh.md) | Selective export + refresh |
| [v14-ai-sdk-benchmark-and-quality.md](v14-ai-sdk-benchmark-and-quality.md) | AI SDK, tokens, benchmark CLI, extraction fixes |
| [v15-efficiency-planned.md](v15-efficiency-planned.md) | Planned efficiency work (not shipped) |

## Key types

Canonical row contract: `ExtractedRecord` in `src/models/schemas.ts` (`row`, `evidence`, `source_urls`).

Entry points: `src/cli.ts`, `src/orchestrator/pipeline.ts`, benchmark via `backend/src/dataset-agent/collection-pipeline-runtime.ts`.
