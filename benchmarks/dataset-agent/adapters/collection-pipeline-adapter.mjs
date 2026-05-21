#!/usr/bin/env node
import { spawnBackendBenchmark } from "./lib/spawn-backend-benchmark.mjs";

const execution = await spawnBackendBenchmark(
  "src/dataset-agent/run-collection-benchmark-adapter.ts"
);

if (execution.stderr) {
  process.stderr.write(execution.stderr);
}
process.stdout.write(execution.stdout);
process.exitCode = execution.exitCode;
