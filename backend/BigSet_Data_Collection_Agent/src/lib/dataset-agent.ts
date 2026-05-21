/**
 * Re-exports the shared dataset-agent module from the BigSet backend.
 * Benchmark and HTTP entrypoints should prefer `npm --prefix backend run collection-agent:benchmark`.
 */
export type {
  DatasetAgentRunInput,
  DatasetAgentRunResult,
} from "../../../src/dataset-agent/types.js";

export {
  createDatasetAgentRuntime,
  runDatasetAgentFromEnv,
} from "../../../src/dataset-agent/index.js";
