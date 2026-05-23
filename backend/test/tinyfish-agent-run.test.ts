import assert from "node:assert/strict";
import { test } from "node:test";

import { tinyfishAgentRunResultFromRun } from "../BigSet_Data_Collection_Agent/src/integrations/tinyfish-agent.js";

test("TinyFish run normalization keeps safe provenance without streaming URL", () => {
  const normalized = tinyfishAgentRunResultFromRun({
    run_id: "run-1",
    status: "COMPLETED",
    goal: "Extract rows.",
    created_at: "2026-05-23T00:00:00Z",
    started_at: "2026-05-23T00:00:01Z",
    finished_at: "2026-05-23T00:00:02Z",
    num_of_steps: 3,
    result: {
      records: [],
    },
    error: null,
    streaming_url: "https://agent.tinyfish.ai/private-stream-token",
    browser_config: {
      proxy_enabled: true,
      proxy_country_code: null,
    },
  } as never);

  assert.equal(normalized.agent_step_count, 3);
  assert.equal(normalized.has_streaming_url, true);
  assert.deepEqual(normalized.result_keys, ["records"]);
  assert.equal(
    JSON.stringify(normalized).includes("private-stream-token"),
    false
  );
});
