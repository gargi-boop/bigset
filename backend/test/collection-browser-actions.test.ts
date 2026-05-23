import assert from "node:assert/strict";
import { test } from "node:test";

import {
  explicitBrowserActionsFromAgentResult,
  explicitBrowserActionsFromAgentRuns,
} from "../BigSet_Data_Collection_Agent/src/orchestrator/browser-actions.js";
import {
  agentRunRecordSchema,
  runReportSchema,
} from "../BigSet_Data_Collection_Agent/src/models/schemas.js";

test("explicit browser actions are copied from Agent results without generic inference", () => {
  const actions = explicitBrowserActionsFromAgentResult({
    pageUrl: "https://example.com/start",
    agentResult: {
      browser_actions: [
        {
          action: "navigate",
          url: "https://example.com/start",
          status: "succeeded",
          phase: "initial",
        },
        "not an action",
      ],
      agent_browser_actions: [{
        action: "click",
        selector: "button[type=submit]",
        target_text: "Submit",
        value_description: "redacted",
        status: "succeeded",
      }],
      actions: [{
        action: "click",
        selector: "#generic-actions-are-ignored",
      }],
    },
  });

  assert.equal(actions.length, 2);
  assert.deepEqual(actions[0], {
    action: "navigate",
    url: "https://example.com/start",
    status: "succeeded",
    phase: "initial",
  });
  assert.deepEqual(actions[1], {
    action: "click",
    url: "https://example.com/start",
    selector: "button[type=submit]",
    target_text: "Submit",
    value_description: "redacted",
    status: "succeeded",
  });
});

test("Agent run records and run reports persist browser action arrays", () => {
  const browserActions = [{
    action: "click",
    url: "https://example.com/start",
    selector: "button[type=submit]",
    target_text: "Submit",
    value_description: "redacted",
    status: "succeeded",
    phase: "initial",
  }];
  const agentRun = agentRunRecordSchema.parse({
    url: "https://example.com/start",
    status: "requires_form_submission",
    run_id: "run-1",
    agent_status: "COMPLETED",
    goal: "Submit the form and extract the result.",
    records_extracted: 1,
    agent_step_count: 3,
    has_streaming_url: true,
    result_keys: ["records"],
    browser_action_diagnostic: "Agent completed and returned rows, but polled run payload exposed no explicit browser actions.",
    browser_actions: browserActions,
  });

  assert.equal(agentRun.agent_step_count, 3);
  assert.equal(agentRun.has_streaming_url, true);
  assert.deepEqual(agentRun.result_keys, ["records"]);

  assert.deepEqual(
    explicitBrowserActionsFromAgentRuns([agentRun]),
    browserActions
  );

  const report = runReportSchema.parse({
    run_id: "run-1",
    prompt: "Find form-backed data.",
    target_rows: 1,
    started_at: "2026-05-23T00:00:00.000Z",
    finished_at: "2026-05-23T00:00:01.000Z",
    duration_ms: 1_000,
    dataset_spec: datasetSpec(),
    stats: {
      ...phaseStats(),
      records_after_merge: 1,
      visualization_records: 1,
    },
    initial: {
      ...phaseStats(),
      search_queries: ["example form"],
      fetched_urls: ["https://example.com/start"],
      failed_urls: [],
      agent_browser_actions: browserActions,
    },
    repair: {
      attempted: true,
      total_loops: 1,
      loops: [{
        loop_index: 1,
        repair_queries: ["example form details"],
        agent_browser_actions: browserActions,
        missing_fields: [],
        records_before: 0,
        records_after: 1,
        fields_filled: {},
        stats: phaseStats(),
      }],
      missing_fields: [],
      repair_queries: ["example form details"],
      records_before: 0,
      records_after: 1,
      fields_filled: {},
      stats: phaseStats(),
    },
    search_queries: ["example form", "example form details"],
    fetched_urls: ["https://example.com/start"],
    failed_urls: [],
    errors: [],
  });

  assert.deepEqual(report.initial.agent_browser_actions, browserActions);
  assert.deepEqual(report.repair.loops[0]?.agent_browser_actions, browserActions);
});

function datasetSpec() {
  return {
    intent_summary: "Find form-backed data.",
    target_row_count: 1,
    row_grain: "company",
    columns: [{
      name: "entity_name",
      type: "string",
      description: "Entity name",
      required: true,
    }],
    dedupe_keys: ["entity_name"],
    search_queries: ["example form"],
    extraction_hints: "Use source-backed rows.",
  };
}

function phaseStats() {
  return {
    search_queries_executed: 1,
    search_results_collected: 1,
    unique_urls_selected: 1,
    pages_fetched: 1,
    pages_failed: 0,
    raw_records_extracted: 1,
    triage: {
      pages_triaged: 1,
      by_status: {
        requires_form_submission: 1,
      },
      extract_now: 0,
      agent_candidates: 1,
      agent_dispatched: 1,
      agent_deferred: 0,
      agent_succeeded: 1,
      agent_failed: 0,
      skipped: 0,
      records_from_extract: 0,
      records_from_agent: 1,
      agent_reported_step_count: 3,
      agent_runs_with_streaming_url: 1,
      agent_runs_with_explicit_browser_actions: 1,
    },
  };
}
