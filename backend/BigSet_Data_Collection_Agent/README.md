# BigSet Data Collection Agent

Multi-phase web data collection pipeline (search → fetch → triage → extract → repair).
It is integrated with the shared BigSet backend via `backend/src/dataset-agent`.

## Benchmark (recommended)

From the repo root, use the collection runtime through the backend benchmark adapter:

```bash
DATASET_AGENT_RUNTIME=collection \
node benchmarks/dataset-agent/run-benchmark.mjs \
  --prompts benchmarks/dataset-agent/prompts-smoke.json \
  --system mengzhe='node benchmarks/dataset-agent/adapters/collection-pipeline-adapter.mjs'
```

For local wiring, copy `benchmarks/dataset-agent/adapters/template-adapter.mjs` to
`local-mengzhe-adapter.mjs` (gitignored) or use the committed
`collection-pipeline-adapter.mjs`.

No-secret smoke:

```bash
DATASET_AGENT_RUNTIME=collection \
COLLECTION_AGENT_RUNTIME=deterministic \
node benchmarks/dataset-agent/run-benchmark.mjs \
  --prompts benchmarks/dataset-agent/prompts-smoke.json \
  --system mengzhe='node benchmarks/dataset-agent/adapters/collection-pipeline-adapter.mjs'
```

Real runs need `TINYFISH_API_KEY` and `OPENROUTER_API_KEY` in `backend/.env` (execution-only; do not commit).

## CLI (full pipeline with artifacts)

```bash
cd backend/BigSet_Data_Collection_Agent
cp .env.example .env
npm install
npm run collect -- run -p "restaurants in Menlo Park that serve Coca-Cola"
```

Runs write CSV/JSON artifacts under `runs/`.

### Benchmark prompts (agent on)

Run all 16 `prompts.json` entries with benchmark criteria and Tinyfish agent enabled:

```bash
npm run collect:benchmark
```

See [benchmarks/dataset-agent/CLI_BENCHMARK.md](../../../benchmarks/dataset-agent/CLI_BENCHMARK.md) and generated `cli-prompts.sh`.

## AI SDK integration

- **Edward path:** `DATASET_AGENT_RUNTIME=ai-sdk` — `ToolLoopAgent` in `backend/src/dataset-agent/ai-sdk-runtime.ts`
- **Collection path:** `DATASET_AGENT_RUNTIME=collection` — this pipeline, normalized through `collection-bridge.ts`

Both implement the same `DatasetAgentRuntime` contract used by the benchmark harness and `POST /dataset-agent/run`.
