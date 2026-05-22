import assert from "node:assert/strict";
import { test } from "node:test";

import {
  failureReason,
  findInfrastructureBlockerReason,
} from "./run-benchmark.mjs";

test("benchmark failure reason prefers capability diagnostic over generic zero rows", () => {
  const diagnostic = "Capability diagnostic: TinyFish Agent disabled; triage requested browser/form/detail follow-up for 2 page(s) (requires_navigation=1, requires_form_submission=1). Enable COLLECTION_AGENT_ENABLE_AGENT=true for live navigation.";

  const reason = failureReason({
    execution: {
      timedOut: false,
      exitCode: 0,
    },
    parsedPayload: {
      rows: [],
      validationIssues: [diagnostic],
    },
    validation: {
      rowCount: 0,
      sourceUrlCount: 0,
      evidenceQuoteCount: 0,
      requiredCellCompletenessRatio: 0,
    },
    answerKeyScore: null,
    infraBlockerReason: null,
    minRequiredCompleteness: 0.75,
    validationIssues: [diagnostic],
  });

  assert.equal(reason, diagnostic);
});

test("infrastructure blocker detection ignores ordinary API-key documentation text", () => {
  const reason = findInfrastructureBlockerReason({
    execution: {
      timedOut: false,
      stderr: "The documentation page covers general API key setup and SDK usage.",
      stdout: "",
    },
    parsedPayload: {
      rows: [{
        cells: {
          summary: "Covers API key setup for developers.",
        },
      }],
    },
    normalized: {
      validationIssues: [
        "Capability diagnostic: TinyFish Agent disabled; triage requested browser/form/detail follow-up for 1 page(s) (requires_navigation=1). Enable COLLECTION_AGENT_ENABLE_AGENT=true for live navigation.",
      ],
    },
  });

  assert.equal(reason, null);
});

test("infrastructure blocker detection still catches missing API key configuration", () => {
  const reason = findInfrastructureBlockerReason({
    execution: {
      timedOut: false,
      stderr: "Missing OPENROUTER_API_KEY.",
      stdout: "",
    },
    parsedPayload: null,
    normalized: {
      validationIssues: [],
    },
  });

  assert.equal(reason, "Infrastructure/auth/credits blocker.");
});
