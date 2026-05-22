import assert from "node:assert/strict";
import { test } from "node:test";

import {
  missingPopulateRuntimePrerequisites,
  populateRuntimePrerequisiteError,
} from "../src/pipeline/populate-runtime-prerequisites.js";

test("populate runtime prerequisite check reports every missing key", () => {
  assert.deepEqual(missingPopulateRuntimePrerequisites({}), [
    "CONVEX_SELF_HOSTED_ADMIN_KEY",
    "OPENROUTER_API_KEY",
    "TINYFISH_API_KEY",
  ]);
});

test("populate runtime prerequisite check skips Convex admin key for dry runs", () => {
  assert.deepEqual(
    missingPopulateRuntimePrerequisites({
      openRouterApiKey: "openrouter",
      tinyFishApiKey: "tinyfish",
      shouldCommitRows: false,
    }),
    []
  );
});

test("populate runtime prerequisite check passes when all keys are configured", () => {
  const input = {
    convexAdminKey: "convex",
    openRouterApiKey: "openrouter",
    tinyFishApiKey: "tinyfish",
  };

  assert.deepEqual(missingPopulateRuntimePrerequisites(input), []);
  assert.equal(populateRuntimePrerequisiteError(input), undefined);
});
