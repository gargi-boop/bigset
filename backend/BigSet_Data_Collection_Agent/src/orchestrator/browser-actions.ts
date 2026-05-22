import {
  browserActionReportSchema,
  type AgentRunRecord,
  type BrowserActionReport,
} from "../models/schemas.js";

const EXPLICIT_BROWSER_ACTION_ARRAY_KEYS = [
  "browser_actions",
  "agent_browser_actions",
] as const;

export function explicitBrowserActionsFromAgentResult(
  input: {
    agentResult: Record<string, unknown> | null;
    pageUrl: string;
  }
): BrowserActionReport[] {
  if (!input.agentResult) {
    return [];
  }

  const actions: BrowserActionReport[] = [];
  for (const key of EXPLICIT_BROWSER_ACTION_ARRAY_KEYS) {
    actions.push(...browserActionsFromValue(input.agentResult[key], input.pageUrl));
  }
  return dedupeBrowserActions(actions);
}

export function explicitBrowserActionsFromAgentRuns(
  agentRuns: AgentRunRecord[]
): BrowserActionReport[] {
  return dedupeBrowserActions(
    agentRuns.flatMap((run) => run.browser_actions ?? [])
  );
}

function browserActionsFromValue(
  value: unknown,
  pageUrl: string
): BrowserActionReport[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => browserActionFromValue(item, pageUrl))
      .filter((action): action is BrowserActionReport => Boolean(action));
  }
  const action = browserActionFromValue(value, pageUrl);
  return action ? [action] : [];
}

function browserActionFromValue(
  value: unknown,
  pageUrl: string
): BrowserActionReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const parsed = browserActionReportSchema.safeParse(value);
  if (!parsed.success || !hasReplayAnchor(parsed.data)) {
    return undefined;
  }
  return {
    ...parsed.data,
    url: parsed.data.url ?? pageUrl,
  };
}

function hasReplayAnchor(action: BrowserActionReport): boolean {
  return Boolean(
    action.url ||
    action.selector ||
    action.target_text ||
    action.targetText
  );
}

function dedupeBrowserActions(
  actions: BrowserActionReport[]
): BrowserActionReport[] {
  const seen = new Set<string>();
  const deduped: BrowserActionReport[] = [];
  for (const action of actions) {
    const key = JSON.stringify([
      action.action ?? "",
      action.url ?? "",
      action.selector ?? "",
      action.target_text ?? action.targetText ?? "",
      action.status ?? "",
      action.error ?? "",
      action.phase ?? "",
      action.label ?? "",
    ]);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(action);
  }
  return deduped;
}
