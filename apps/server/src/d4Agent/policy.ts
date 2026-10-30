import { D4_AGENT_TOOLS } from "@d4research/provider-core/server/d4AgentPolicy";
import * as DateTime from "effect/DateTime";
import {
  canStartProviderTurn,
  supportsD4AgentDriver,
  type AgentMonitorUpdate,
  type D4AgentSettings,
  type D4AgentState,
  type D4AgentTurnUsage,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  type ServerProvider,
} from "@d4research/contracts";
import type { ThreadLaunchWorkspaceStrategy } from "../orchestration-v2/ThreadLaunchService.ts";

export { D4_AGENT_PREFIX, D4_AGENT_TOOLS } from "@d4research/provider-core/server/d4AgentPolicy";

export function modelAvailability(
  settings: D4AgentSettings,
  providers: ReadonlyArray<ServerProvider>,
  requireAgentDriver = true,
): D4AgentState["unavailableReason"] {
  if (!settings.enabled) return "disabled";
  const selection = settings.modelSelection;
  if (selection === null) return "model-not-selected";
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  if (provider === undefined || !canStartProviderTurn(provider)) return "provider-unavailable";
  const model = provider.models.find((entry) => entry.slug === selection.model);
  if (
    model === undefined ||
    provider.updateRequiredModels?.some((entry) => entry.slug === selection.model)
  )
    return "model-unavailable";
  if (requireAgentDriver && !supportsD4AgentDriver(provider.driver)) return "sandbox-unavailable";
  for (const option of selection.options ?? []) {
    const descriptor = model.capabilities?.optionDescriptors?.find(
      (entry) => entry.id === option.id,
    );
    if (
      descriptor === undefined ||
      (descriptor.type === "boolean"
        ? typeof option.value !== "boolean"
        : !descriptor.options.some((entry) => entry.id === option.value))
    )
      return "option-unavailable";
  }
  return null;
}

/** New work is fail-closed on its own configured worker, including a live exhausted quota. */
export function taskModelAvailability(
  settings: D4AgentSettings,
  providers: ReadonlyArray<ServerProvider>,
  now: number,
  requireAgentDriver = true,
): D4AgentState["unavailableReason"] {
  const selection = settings.taskModelSelection;
  if (selection === null) return "model-not-selected";
  const availability = modelAvailability(
    { ...settings, modelSelection: selection },
    providers,
    requireAgentDriver,
  );
  if (availability !== null) return availability;
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId)!;
  const exhausted = provider.usageLimits?.windows.some(
    (window) =>
      window.usedPercent >= 100 &&
      (window.resetsAt === undefined || Date.parse(window.resetsAt) > now),
  );
  return exhausted ? "provider-unavailable" : null;
}

export function selectionsEqual(a: ModelSelection, b: ModelSelection): boolean {
  const options = (s: ModelSelection) =>
    JSON.stringify([...(s.options ?? [])].sort((x, y) => x.id.localeCompare(y.id)));
  return a.instanceId === b.instanceId && a.model === b.model && options(a) === options(b);
}

export function contentFreeDigest(
  updates: ReadonlyArray<AgentMonitorUpdate>,
  now: number,
  ownThreadId: string | null,
) {
  const reports = updates.flatMap(({ threadId, report }) =>
    report === null || threadId === ownThreadId
      ? []
      : [
          {
            threadId,
            classification: report.classification,
            reason: report.reason,
            attentionRequired: report.attentionRequired,
            reportKey: report.reportKey,
            ageSeconds: Math.max(0, Math.floor((now - Date.parse(report.observedAt)) / 1000)),
          },
        ],
  );
  const counts: Record<string, number> = {};
  for (const report of reports)
    counts[report.classification] = (counts[report.classification] ?? 0) + 1;
  return {
    counts,
    reports: reports
      .sort((a, b) => Number(b.attentionRequired) - Number(a.attentionRequired))
      .slice(0, 200),
    omitted: Math.max(0, reports.length - 200),
  };
}

type DigestReport = ReturnType<typeof contentFreeDigest>["reports"][number];

// Report keys are server-side dedupe identities that can be kilobytes long; models never need them.
export function modelFacingReport({ reportKey: _reportKey, ...report }: DigestReport) {
  return report;
}

export function compactDigest(
  updates: ReadonlyArray<AgentMonitorUpdate>,
  now: number,
  ownThreadId: string | null,
) {
  const digest = contentFreeDigest(updates, now, ownThreadId);
  return {
    ...digest,
    reports: digest.reports.slice(0, 20).map(modelFacingReport),
    omitted: digest.omitted + Math.max(0, digest.reports.length - 20),
  };
}

const zoneMinute = (now: number, timeZone: string): number | undefined => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(now);
    const part = (type: "hour" | "minute") =>
      Number(parts.find((entry) => entry.type === type)?.value);
    const minute = part("hour") * 60 + part("minute");
    return Number.isInteger(minute) ? minute : undefined;
  } catch {
    // An unknown zone name falls back to the stored offset.
    return undefined;
  }
};

export function isQuietHour(now: number, quiet: D4AgentSettings["quietHours"]): boolean {
  if (quiet === null || quiet.startMinute === quiet.endMinute) return false;
  const offsetParts = DateTime.toPartsUtc(
    DateTime.makeUnsafe(now + quiet.utcOffsetMinutes * 60_000),
  );
  const minute =
    (quiet.timeZone === undefined ? undefined : zoneMinute(now, quiet.timeZone)) ??
    offsetParts.hour * 60 + offsetParts.minute;
  return quiet.startMinute < quiet.endMinute
    ? minute >= quiet.startMinute && minute < quiet.endMinute
    : minute >= quiet.startMinute || minute < quiet.endMinute;
}

/** The time and activity part of heartbeatDue; checked before the digest is built. */
export function heartbeatWindowOpen(input: {
  settings: D4AgentSettings;
  now: number;
  lastAt: number;
  busy: boolean;
}): boolean {
  return (
    input.settings.enabled &&
    input.settings.heartbeatMinutes !== null &&
    !input.busy &&
    !isQuietHour(input.now, input.settings.quietHours) &&
    input.now - input.lastAt >= input.settings.heartbeatMinutes * 60_000
  );
}

export function heartbeatDue(input: {
  settings: D4AgentSettings;
  now: number;
  lastAt: number;
  previousKeys: ReadonlyArray<string>;
  attentionKeys: ReadonlyArray<string>;
  busy: boolean;
}): boolean {
  return (
    heartbeatWindowOpen(input) &&
    input.attentionKeys.some((key) => !input.previousKeys.includes(key))
  );
}

// Keep an explicit attribute allowlist so caller payloads cannot add message content.
export function usageAttributes(input: {
  provider: string;
  model: string;
  conversationId: string;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationTokens?: number;
}): D4AgentTurnUsage["attributes"] {
  const count = (n: number | undefined) =>
    n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  const inputTokens = count(input.inputTokens),
    outputTokens = count(input.outputTokens),
    cacheRead = count(input.cachedInputTokens),
    cacheWrite = count(input.cacheCreationTokens);
  return {
    "gen_ai.provider.name": input.provider,
    "gen_ai.request.model": input.model,
    "gen_ai.operation.name": "chat",
    "gen_ai.conversation.id": input.conversationId,
    "d4.agent.duration_ms": Math.max(0, Math.floor(input.durationMs)),
    ...(inputTokens === undefined ? {} : { "gen_ai.usage.input_tokens": inputTokens }),
    ...(outputTokens === undefined ? {} : { "gen_ai.usage.output_tokens": outputTokens }),
    ...(cacheRead === undefined ? {} : { "gen_ai.usage.cache_read.input_tokens": cacheRead }),
    ...(cacheWrite === undefined ? {} : { "gen_ai.usage.cache_creation.input_tokens": cacheWrite }),
  };
}

export function isAllowedAgentMcpRequest(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const request = value as { method?: unknown; params?: { name?: unknown } };
  if (request.method === "tools/call") return D4_AGENT_TOOLS.includes(String(request.params?.name));
  return [
    "initialize",
    "notifications/initialized",
    "ping",
    "tools/list",
    "notifications/cancelled",
  ].includes(String(request.method));
}

const TASK_TITLE_LIMIT = 60;

/** A sidebar title from a drafted brief: its first line without a "Task:" label or final period. */
export function taskTitle(text: string): string {
  const line = (text.trim().split("\n")[0] ?? "")
    .replace(/^task\s*:\s*/i, "")
    .replace(/\.+$/, "")
    .trim();
  if (line.length <= TASK_TITLE_LIMIT) return line || "Nia task";
  const cut = line.slice(0, TASK_TITLE_LIMIT - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > TASK_TITLE_LIMIT / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const taskRuntimeModes: ReadonlyArray<RuntimeMode> = ["auto", "auto-accept-edits"];

/**
 * A guarded card was judged by Tool Guard and approved by a person, so its task may work without
 * a click per step, but only up to "auto": the provider still sandboxes or reviews each step,
 * which full-access would not. An unguarded card keeps per-step approval in the task thread.
 */
export function taskRuntimeMode(
  guarded: boolean,
  provider: Pick<ServerProvider, "supportedRuntimeModes"> | undefined,
): RuntimeMode {
  if (!guarded) return "approval-required";
  const supported = provider?.supportedRuntimeModes;
  if (supported === undefined || supported.length === 0) return "auto";
  return taskRuntimeModes.find((mode) => supported.includes(mode)) ?? "approval-required";
}

/** A configured base ref gives each task a fresh worktree; otherwise it shares the project root. */
export function taskWorkspace(
  settings: Pick<D4AgentSettings, "projectWorktreeBaseRefs">,
  projectId: ProjectId,
): ThreadLaunchWorkspaceStrategy {
  const baseRef = settings.projectWorktreeBaseRefs[projectId];
  return baseRef === undefined
    ? { type: "root" }
    : { type: "worktree", baseRef, startFromOrigin: false };
}
