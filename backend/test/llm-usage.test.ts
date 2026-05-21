import assert from "node:assert/strict";
import { test } from "node:test";

import {
  emptyLlmUsage,
  recordLanguageModelUsage,
  runWithLlmUsageScope,
  toDatasetAgentUsage,
} from "../BigSet_Data_Collection_Agent/src/llm/usage.js";

test("runWithLlmUsageScope accumulates language model usage", async () => {
  const { usage } = await runWithLlmUsageScope(async () => {
    recordLanguageModelUsage({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      inputTokenDetails: {
        noCacheTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokenDetails: {
        textTokens: 50,
        reasoningTokens: 0,
      },
    });
    recordLanguageModelUsage({
      inputTokens: 200,
      outputTokens: 80,
      totalTokens: 280,
      inputTokenDetails: {
        noCacheTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      outputTokenDetails: {
        textTokens: 80,
        reasoningTokens: 0,
      },
    });
    return "done";
  });

  assert.equal(usage.callCount, 2);
  assert.equal(usage.promptTokens, 300);
  assert.equal(usage.completionTokens, 130);
  assert.equal(usage.totalTokens, 430);
  assert.deepEqual(toDatasetAgentUsage(usage), {
    promptTokens: 300,
    completionTokens: 130,
    totalTokens: 430,
  });
});

test("recordLanguageModelUsage is a no-op outside a scope", () => {
  recordLanguageModelUsage({
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    inputTokenDetails: {
      noCacheTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokenDetails: {
      textTokens: 5,
      reasoningTokens: 0,
    },
  });
  assert.deepEqual(emptyLlmUsage(), {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    callCount: 0,
  });
});
