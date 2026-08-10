import type {
  OrchestrationEvent,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const RESEARCH_DELEGATE_NAME = /(?:^|__)research_delegate$/i;

function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return asRecord(value);
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function findNestedFiniteNumber(value: unknown, key: string, depth = 0): number | null {
  if (depth > 6) return null;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findNestedFiniteNumber(child, key, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  const record = parseRecord(value);
  if (!record) return null;
  const direct = record[key];
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  for (const child of Object.values(record)) {
    const found = findNestedFiniteNumber(child, key, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function findNestedTrue(value: unknown, keys: ReadonlySet<string>, depth = 0): boolean {
  if (depth > 6) return false;
  if (Array.isArray(value)) {
    return value.some((child) => findNestedTrue(child, keys, depth + 1));
  }
  const record = parseRecord(value);
  if (!record) return false;
  for (const [key, child] of Object.entries(record)) {
    if (keys.has(key) && child === true) return true;
    if (findNestedTrue(child, keys, depth + 1)) return true;
  }
  return false;
}

/**
 * Preserve only the small research ledger across activity projection. ACP
 * stores the delegate arguments in `rawInput`, which normal projection drops;
 * retaining the full provider output would undo the snapshot size reduction.
 */
function projectResearchDelegate(
  payload: Record<string, unknown>,
  data: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const item = asRecord(data.item);
  const state = asRecord(data.state);
  const rawInput = parseRecord(data.rawInput);
  const names = [
    payload.title,
    data.toolName,
    data.tool,
    item?.tool,
    item?.name,
    rawInput?.toolName,
    rawInput?.tool,
    rawInput?.name,
  ];
  if (!names.some((name) => typeof name === "string" && RESEARCH_DELEGATE_NAME.test(name))) {
    return undefined;
  }
  const input =
    asRecord(data.input) ??
    asRecord(item?.arguments) ??
    asRecord(item?.input) ??
    asRecord(state?.input) ??
    asRecord(rawInput?.arguments) ??
    asRecord(rawInput?.input) ??
    rawInput;
  if (!input) return undefined;
  const step = asTrimmedString(input.step);
  const target = asTrimmedString(input.target);
  if (!step && !target) return undefined;
  const visit =
    typeof input.visit === "number" && Number.isSafeInteger(input.visit) && input.visit > 0
      ? input.visit
      : 1;
  const output = data.output ?? item?.result ?? state?.output ?? data.rawOutput ?? data.result;
  const callId =
    asTrimmedString(data.toolCallId) ??
    asTrimmedString(data.toolUseId) ??
    asTrimmedString(item?.id) ??
    asTrimmedString(state?.toolCallId);
  const remainingBudget = findNestedFiniteNumber(output, "remainingBudget");
  const durationMs = findNestedFiniteNumber(output, "durationMs");
  return {
    ...(callId ? { callId } : {}),
    ...(step ? { step } : {}),
    ...(target ? { target } : {}),
    visit,
    ...(remainingBudget !== null ? { remainingBudget } : {}),
    ...(durationMs !== null ? { durationMs } : {}),
    failed:
      payload.status === "failed" ||
      state?.status === "error" ||
      findNestedTrue(output, new Set(["is_error", "isError"])),
  };
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown): void {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function projectCommandData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = asRecord(data.item);
  if (!item) {
    return undefined;
  }

  const projectedItem: Record<string, unknown> = {};
  if ("command" in item) {
    projectedItem.command = item.command;
  }

  const input = asRecord(item.input);
  if (input && "command" in input) {
    projectedItem.input = { command: input.command };
  }

  const result = asRecord(item.result);
  if (result && "command" in result) {
    projectedItem.result = { command: result.command };
  }

  return Object.keys(projectedItem).length > 0 ? projectedItem : undefined;
}

function summarizeToolTextOutput(value: string): string | null {
  const lines: string[] = [];
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (line.length > 0) {
      lines.push(line);
    }
  }

  const firstLine = lines.find((line) => line !== "```");
  if (firstLine) {
    return firstLine.length <= 84 ? firstLine : `${firstLine.slice(0, 83).trimEnd()}…`;
  }
  if (lines.length > 1) {
    return `${lines.length.toLocaleString()} lines`;
  }
  return null;
}

function projectRawOutput(value: unknown): Record<string, unknown> | undefined {
  const rawOutput = asRecord(value);
  if (!rawOutput) {
    return undefined;
  }

  if (typeof rawOutput.totalFiles === "number" && Number.isFinite(rawOutput.totalFiles)) {
    return {
      totalFiles: rawOutput.totalFiles,
      ...(rawOutput.truncated === true ? { truncated: true } : {}),
    };
  }

  const content = asTrimmedString(rawOutput.content);
  if (content) {
    const summary = summarizeToolTextOutput(content);
    return summary ? { content: summary } : undefined;
  }

  const stdout = asTrimmedString(rawOutput.stdout);
  if (stdout) {
    const summary = summarizeToolTextOutput(stdout);
    return summary ? { content: summary } : undefined;
  }

  return undefined;
}

/**
 * Removes activity payload fields that no current client reads while retaining
 * the full payload in persistence and the event store.
 */
export function projectActivityPayload(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  if (!payload || !data) {
    return activity;
  }
  const researchDelegate = projectResearchDelegate(payload, data);
  if (payload.itemType === "mcp_tool_call") {
    return researchDelegate
      ? {
          ...activity,
          payload: { ...payload, data: { ...data, researchDelegate } },
        }
      : activity;
  }

  const projectedData: Record<string, unknown> = {};
  if (researchDelegate) {
    projectedData.researchDelegate = researchDelegate;
  }
  const item = projectCommandData(data);
  if (item) {
    projectedData.item = item;
  }
  if ("command" in data) {
    projectedData.command = data.command;
  }

  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);
  if (changedFiles.length > 0) {
    // Both clients discover file names by walking objects with path-like keys.
    projectedData.files = changedFiles.map((path) => ({ path }));
  }

  if ("toolCallId" in data) {
    projectedData.toolCallId = data.toolCallId;
  }
  if ("kind" in data) {
    projectedData.kind = data.kind;
  }

  const rawOutput = projectRawOutput(data.rawOutput);
  if (rawOutput) {
    projectedData.rawOutput = rawOutput;
  }

  return {
    ...activity,
    payload: {
      ...payload,
      data: projectedData,
    },
  };
}

/**
 * Matches the validity rule in the web client's
 * `deriveLatestContextWindowSnapshot`: rows without a finite, non-negative
 * `usedTokens` are skipped during its backward walk, so they must not shadow
 * an earlier resolvable row here.
 */
function isResolvableContextWindowActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-window.updated") {
    return false;
  }
  const payload = asRecord(activity.payload);
  const usedTokens = payload?.usedTokens;
  return typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
}

/**
 * Drops all but the last resolvable context-window activity per turn from a
 * snapshot. Clients only ever read the latest usage value (walking the array
 * backwards), so shipping the full history — often thousands of rows on long
 * threads — buys nothing. Retention is per turn rather than per thread because
 * a live `thread.reverted` makes the client discard whole turns; keeping each
 * turn's latest row means the meter can still resolve a value from the turns
 * that survive. Malformed rows pass through untouched rather than shadowing a
 * valid earlier row. Live `thread.activity-appended` events are untouched:
 * newer updates still stream through and supersede the retained rows on the
 * client.
 */
function dropStaleContextWindowActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const latestIndexByTurn = new Map<string | null, number>();
  for (let index = 0; index < activities.length; index += 1) {
    if (isResolvableContextWindowActivity(activities[index]!)) {
      latestIndexByTurn.set(activities[index]!.turnId, index);
    }
  }
  if (latestIndexByTurn.size === 0) {
    return activities;
  }
  return activities.filter(
    (activity, index) =>
      !isResolvableContextWindowActivity(activity) ||
      latestIndexByTurn.get(activity.turnId) === index,
  );
}

export function projectThreadDetailSnapshot(
  snapshot: OrchestrationThreadDetailSnapshot,
): OrchestrationThreadDetailSnapshot {
  return {
    ...snapshot,
    thread: {
      ...snapshot.thread,
      activities: dropStaleContextWindowActivities(snapshot.thread.activities).map(
        projectActivityPayload,
      ),
    },
  };
}

export function projectActivityEvent(event: OrchestrationEvent): OrchestrationEvent {
  if (event.type !== "thread.activity-appended") {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      activity: projectActivityPayload(event.payload.activity),
    },
  };
}
