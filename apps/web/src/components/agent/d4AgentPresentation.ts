import type {
  D4AgentActionSummary,
  D4AgentState,
  D4AgentSystemCheck,
  D4BrainContext,
  ProjectId,
  D4AgentSettings,
} from "@d4research/contracts";
import {
  threadRuntimeIsActive,
  type ThreadRunSummary,
  type ThreadRuntimeSummary,
} from "@d4research/client-runtime/state/models";

export function systemCheckLabel(check: D4AgentSystemCheck): string {
  return {
    "user-units": "User services",
    "system-units": "System services",
    "os-updates": "OS updates",
    doctor: "Doctor",
    "root-disk": "Root disk",
    "data-disk": "Data disk",
    server: "Server health",
  }[check.id];
}
export function systemCheckStatus(check: D4AgentSystemCheck): string {
  if (check.status === "unavailable") return "Not available";
  if (check.status === "disabled") return "Off";
  if (check.status === "info") return check.title ?? "Information";
  const status = check.status === "attention" ? "Needs attention" : "Healthy";
  if ((check.id === "os-updates" || check.id === "doctor") && check.title)
    return `${status} · ${check.title}`;
  if (check.value === null) return status;
  if (check.id === "root-disk" || check.id === "data-disk")
    return `${status} · ${check.value}% used`;
  if (check.id === "user-units" || check.id === "system-units")
    return `${status} · ${check.value} failed services`;
  return status;
}
export function agentUnavailableMessage(reason: D4AgentState["unavailableReason"]): string {
  switch (reason) {
    case "disabled":
      return "Agent chat is off. Enable it in Settings → General → Nia.";
    case "model-not-selected":
      return "Choose an agent model in Settings → General → Nia.";
    case "provider-unavailable":
      return "The selected provider is unavailable. Check its connection in Settings.";
    case "model-unavailable":
      return "The selected model is unavailable. Choose an available model in Settings → General → Nia.";
    case "option-unavailable":
      return "The selected model options are unavailable. Update them in Settings → General → Nia.";
    case "sandbox-unavailable":
      return "The selected provider cannot enforce the agent permissions. Choose a supported provider in Settings → General → Nia.";
    case null:
      return "";
  }
}

export function projectBelongsToAgentContext(
  projectId: ProjectId,
  context: D4BrainContext,
  mappings: D4AgentSettings["projectContexts"],
): boolean {
  return context === "Global" || mappings[projectId] === context;
}

export function brainIndexStatus(index: D4AgentState["brainIndexes"][number]): string {
  if (index.status === "refused")
    return "Context operation refused; inspect the selected scope configuration.";
  const status = {
    ready: "Ready",
    "not-available": "Not available",
    "not-indexed": "Not indexed",
    disabled: "Off",
  }[index.status];
  return `${status} · ${index.files} files · Last rebuild: ${index.lastRebuild ?? "Not available"}`;
}

// Context switches carry a readable server-filled preview; launches name their project; other
// actions show their raw target.
export function actionHeading(
  record: Pick<D4AgentActionSummary, "type" | "targetId" | "preview">,
  projectTitle?: string,
): { title: string; detail: string } {
  if (record.type === "switch-context") return { title: record.preview, detail: "" };
  if (launchTag(record.type) !== null)
    return { title: projectTitle ?? record.targetId, detail: record.preview };
  return { title: `${record.type} · ${record.targetId}`, detail: record.preview };
}

/** The tag of an action that creates a thread, or null for every other action. */
export function launchTag(type: D4AgentActionSummary["type"]): string | null {
  return type === "start"
    ? "New thread"
    : type === "research"
      ? "Research"
      : type === "pipeline"
        ? "Pipeline"
        : null;
}

export function approveLabel(type: D4AgentActionSummary["type"]): string {
  return type === "send"
    ? "Send"
    : type === "switch-context"
      ? "Switch"
      : launchTag(type) !== null
        ? "Create thread"
        : "Approve";
}

/** Tool Guard's verdict on an action, or null when no notice is due. */
export function guardNotice(
  guard: D4AgentActionSummary["guard"],
): { title: string; tone: "warning" | "info" } | null {
  if (guard === undefined || guard.decision === "allowed") return null;
  const rule = guard.rule ? ` (${guard.rule})` : "";
  switch (guard.decision) {
    case "denied":
      return { title: `Tool Guard blocked this action${rule}.`, tone: "warning" };
    case "escalated":
      return { title: `Tool Guard holds this action for you${rule}.`, tone: "warning" };
    case "unavailable":
      return { title: "Tool Guard did not answer, so this action waits for you.", tone: "warning" };
    case "flagged":
      return { title: `Tool Guard flagged this action${rule}.`, tone: "info" };
  }
}

/** What Nia is doing now, from its own thread's run state. */
export function agentActivityLabel(input: {
  runtime: ThreadRuntimeSummary | null;
  latestRun: ThreadRunSummary | null;
  formatTime: (iso: string) => string;
}): { text: string; tone: "working" | "error" | "idle" } {
  const { runtime, latestRun } = input;
  if (runtime?.status === "waiting") return { text: "Nia is waiting for you.", tone: "working" };
  if (threadRuntimeIsActive(runtime))
    return { text: "Nia is working on a reply…", tone: "working" };
  if (runtime?.status === "failed" || runtime?.lastError)
    return {
      text: `Last reply failed${runtime.lastError ? `: ${runtime.lastError.slice(0, 120)}` : "."}`,
      tone: "error",
    };
  if (latestRun?.completedAt)
    return { text: `Last reply at ${input.formatTime(latestRun.completedAt)}.`, tone: "idle" };
  return { text: "Nia is idle.", tone: "idle" };
}

/** Whether Nia looks at threads on its own, or only when asked. */
export function agentWatchLabel(input: {
  heartbeatMinutes: D4AgentSettings["heartbeatMinutes"];
  monitorEnabled: boolean;
}): { text: string; off: boolean } {
  if (!input.monitorEnabled) return { text: "Thread monitor is off.", off: true };
  if (input.heartbeatMinutes === null)
    return { text: "Automatic checks are off. Nia acts only when you write.", off: true };
  return { text: `Checks threads every ${input.heartbeatMinutes} min.`, off: false };
}

export function niaPresence(
  activity: ReturnType<typeof agentActivityLabel>,
  watch: ReturnType<typeof agentWatchLabel>,
): "working" | "watching" | "error" | "off" {
  if (activity.tone === "working") return "working";
  if (activity.tone === "error") return "error";
  return watch.off ? "off" : "watching";
}
