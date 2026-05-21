# v0.4: Parallel workers

v0.4 replaces sequential search/fetch and basic `mapWithConcurrency` with a shared **TaskQueue** that supports:

- **Parallel workers** — bounded concurrency per stage
- **Rate limits** — token-bucket RPM caps per API (OpenRouter, Tinyfish Search/Fetch/Agent)
- **Domain throttling** — max concurrent operations per hostname (fetch batches + agent runs)
- **Retries** — exponential backoff on 429/5xx/timeouts

## What runs in parallel

| Stage | Queue | Default concurrency | Rate limit |
|-------|--------|---------------------|------------|
| Search | `createSearchQueue` | 4 | `TINYFISH_SEARCH_RPM` |
| Fetch | `createFetchQueue` | 4 batches | `TINYFISH_FETCH_RPM` + domain cap |
| Triage | `createTriageQueue` | 5 | `OPENROUTER_RPM` (shared) |
| Extract | `createExtractionQueue` | 5 | `OPENROUTER_RPM` (shared) |
| Agent goals (LLM) | `createAgentQueue` | 2 | `OPENROUTER_RPM` (shared) |
| Tinyfish Agent | async queue + poll | queue 10 / poll 10 | `TINYFISH_AGENT_RPM` on queue |

Agent runs use Tinyfish **`/run-async`**: all jobs are queued quickly (`AGENT_QUEUE_CONCURRENCY`), then polled in parallel (`AGENT_POLL_CONCURRENCY`) until each run completes or hits `AGENT_POLL_TIMEOUT_MS` (default 20 minutes). On timeout the client calls `POST /v1/runs/{id}/cancel` to stop stale PENDING/RUNNING jobs before reporting failure.

Fetch still batches up to `FETCH_BATCH_SIZE` (10) URLs per API call; multiple batches run in parallel.

## Configuration

```env
SEARCH_CONCURRENCY=4
FETCH_CONCURRENCY=4
FETCH_BATCH_SIZE=10
EXTRACTION_CONCURRENCY=5
TRIAGE_CONCURRENCY=5
AGENT_CONCURRENCY=2
AGENT_QUEUE_CONCURRENCY=10
AGENT_POLL_CONCURRENCY=10
AGENT_POLL_INTERVAL_MS=3000
AGENT_POLL_TIMEOUT_MS=1200000
MAX_CONCURRENT_PER_DOMAIN=2
MAX_RETRIES=2
RETRY_BASE_DELAY_MS=1000
OPENROUTER_RPM=60
TINYFISH_SEARCH_RPM=30
TINYFISH_FETCH_RPM=30
TINYFISH_AGENT_RPM=10
```

## Implementation

- `src/queue/task-queue.ts` — worker pool
- `src/queue/rate-limiter.ts` — token bucket
- `src/queue/domain-throttle.ts` — per-domain semaphores
- `src/queue/retry.ts` — retryable error detection + backoff
- `src/queue/pools.ts` — preconfigured queues

Tune `FETCH_CONCURRENCY`, `AGENT_QUEUE_CONCURRENCY`, and `AGENT_POLL_CONCURRENCY` upward for speed; tune RPM and `MAX_CONCURRENT_PER_DOMAIN` downward if you hit 429s or blocks.
