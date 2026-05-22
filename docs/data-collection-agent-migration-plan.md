# Data Collection Agent Migration Plan

This plan keeps the app, benchmark harness, and self-healing layer aligned while
the collection pipeline is migrated into BigSet.

## Current State

- PR #31-#37 form the current Mastra populate/self-healing stack. They are
  intentionally stacked and should not be merged out of order.
- PR #37 adds `make verify-self-healing`, which is the cheap local gate before
  touching live data or spending OpenRouter/TinyFish credits.
- `feat/data-collection-agent-v14` vendors the collection pipeline under
  `backend/BigSet_Data_Collection_Agent` and includes the memory module.
- Clean `feat/data-collection-agent-v14` tests pass once ignored backend
  dependencies are present, but `npm --prefix backend run build` still fails on
  TypeScript/API integration issues:
  - TinyFish run status is typed too narrowly.
  - OpenRouter provider return type leaks private declaration details.
  - Backend compile depends on generated frontend Convex API output.
  - AI SDK `maxTokens` option no longer matches the installed SDK type.

## Target Shape

The app should have one stable populate boundary:

```text
POST /populate or cron CLI
  -> load DatasetContext
  -> self-healing populate service
  -> selected PopulateRecipeRuntime
  -> source-backed rows + evidence
  -> validation gate
  -> optional Convex atomic row replace
```

The collection pipeline should become one implementation of
`PopulateRecipeRuntime`. It should not own app auth, row deletion, Convex writes,
or cron scheduling. Those stay in BigSet.

The critical contract is `runRecipe({ recipe, context })`. A collection runtime
adapter must thread `recipe.runtimeInstructions` into the collection prompt/spec,
because those instructions are how a repaired recipe changes future runtime
behavior. A runtime that ignores `recipe.runtimeInstructions` is not actually
self-healing.

## What Self-Healing Does Now

The current layer:

- stores active recipes and run records in a filesystem recipe store on the
  durable app/commit path
- reruns the active recipe when one exists
- generates an initial recipe when no active recipe exists
- repairs a failed active recipe through `DefaultPopulateRecipeAuthor`
- validates rows for requested-column completeness, source URL coverage,
  evidence quote coverage, and expected-entity coverage when the prompt names
  explicit entities
- promotes a repaired recipe only if it is valid and does not score below the
  active recipe baseline
- commits rows only after a successful tick, using one Convex atomic replace
- supports a CLI path for cron/live smoke via `populate:self-heal --dataset-id`

Dry-run and benchmark paths intentionally use in-memory stores so they do not
pollute durable recipe history.

The current layer does not yet:

- run the collection pipeline as its runtime
- generate Playwright scripts as a durable production recipe
- run a green live Convex canary in this local environment
- prove quality on a full real benchmark for the collection runtime

## Migration Sequence

1. Branch from the top of the self-healing stack.
   - Base new work on `codex/self-healing-verification`.
   - Do not edit `main` or `feat/data-collection-agent-v14` directly.

2. Fix the collection branch as a clean build source.
   - Port only the needed collection pipeline files into the fresh branch.
   - Fix the TypeScript/API issues listed above.
   - Keep vendored code isolated until the adapter is green.
   - Preserve the current backend Convex boundary: do not reintroduce imports
     from `frontend/convex/_generated` into backend compile. Use the existing
     `anyApi`/HTTP-client boundary instead.
   - Exclude non-essential vendored artifacts from the PR scope until the
     runtime adapter needs them.
   - Gate: `npm --prefix backend test` and `npm --prefix backend run build`.

3. Add a collection runtime adapter.
   - Implement the existing `PopulateRecipeRuntime` interface.
   - Input: BigSet `DatasetContext`.
   - Transform `recipe.runtimeInstructions` into the collection pipeline
     prompt/spec alongside the dataset description and columns.
   - Output: rows, source URLs, evidence quotes, usage, metrics, and debug
     captured sources.
   - No direct Convex writes inside the adapter.
   - Gate: a unit test proving a repaired recipe's runtime instructions reach
     the downstream collection prompt/spec and can change observable runtime
     behavior.

4. Add runtime selection through the real entrypoints.
   - Add a runtime factory for the self-healing runner.
   - Add an env switch such as `POPULATE_AGENT_RUNTIME=collection`.
   - Wire both `POST /populate` and `populate:self-heal --dataset-id` through
     that same factory.
   - Gate: one HTTP-route test, one CLI test, and one dry-run smoke proving both
     entrypoints use the selected runtime.

5. Add a self-healing-wrapped benchmark adapter for the collection runtime.
   - Reuse `benchmarks/dataset-agent/run-benchmark.mjs`.
   - Exercise `SelfHealingPopulateRecipeService` with the collection runtime
     inside it, not the direct collection pipeline alone.
   - Compare this lane against the existing Mastra-inside-self-healing lane.
   - Return blocked results when required API keys are missing.
   - Gate: no-key smoke must block with zero tokens, zero tool calls, and zero
     estimated spend.

6. Run quality gates in increasing cost order.
   - `make verify-self-healing`
   - 2-prompt real benchmark
   - full benchmark only after the 2-prompt run is not obviously broken
   - live `--dataset-id` dry-run only after Convex/env prerequisites are ready
   - `--commit` only on a throwaway dataset first

7. Keep runtime selection explicit.
   - Keep current Mastra runtime as default until collection runtime benchmark
     evidence is better.
   - Do not claim collection runtime quality from a direct, non-self-healing
     benchmark lane.

8. Decide merge order from evidence, not preference.
   - If collection runtime is better, stack it after #37 and merge the stack
     from bottom to top.
   - If collection runtime is not better, keep it as a draft branch and use
     benchmark artifacts to decide what to fix next.

## Acceptance Gates

Before any merge:

- no real `.env` files or private notes in the diff
- `git diff --name-status main...HEAD` reviewed for public PR hygiene
- `make verify-self-healing` passes
- `npm --prefix backend test` passes
- `npm --prefix backend run build` passes
- adapter test proves `recipe.runtimeInstructions` reaches the collection
  pipeline prompt/spec
- HTTP-route and CLI tests prove `POPULATE_AGENT_RUNTIME=collection` reaches
  the selected runtime through real app entrypoints
- benchmark no-key smoke proves blocked with zero spend
- benchmark evidence comes from the collection runtime wrapped inside the
  self-healing service, not the direct collection pipeline alone
- real benchmark artifacts are linked in the PR when runtime quality is claimed
- live dataset commit is tested only on a throwaway dataset
- backend build does not depend on `frontend/convex/_generated`

## Next Engineering Move

Create a fresh branch from `codex/self-healing-verification` and first implement
the collection runtime adapter contract, including the
`recipe.runtimeInstructions` bridge and its unit test. Do not wire it as the
default runtime until the self-healing-wrapped benchmark adapter produces better
evidence than the current Mastra path.
