import type {
  D4AgentAction,
  D4AgentActionSummary,
  D4AgentState,
  D4AgentSystemCheck,
  D4BrainContext,
  ProjectId,
  D4AgentSettings,
} from "@d4research/contracts";

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
      return "Agent chat is off. Enable it in Settings → Nia and threads.";
    case "model-not-selected":
      return "Choose an agent model in Settings → Nia and threads.";
    case "provider-unavailable":
      return "The selected provider is unavailable. Check its connection in Settings.";
    case "model-unavailable":
      return "The selected model is unavailable. Choose an available model in Settings → Nia and threads.";
    case "option-unavailable":
      return "The selected model options are unavailable. Update them in Settings → Nia and threads.";
    case "sandbox-unavailable":
      return "The selected provider cannot enforce the agent permissions. Choose a supported provider in Settings → Nia and threads.";
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

/** The untruncated text a pending card shows, where the summary preview is capped. */
export function actionFullText(action: D4AgentAction): string | null {
  if ("text" in action) return action.text;
  if (action.type === "pc") return action.command;
  if (action.type === "answer") return JSON.stringify(action.answers);
  return null;
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

// Older transcripts carry session bookkeeping posts; they are not messages for the user.
const SESSION_NOTICE =
  /^(New session\.|Resumed \S+ session\.|Context changed to \S+\. New session\.|Session size limit reached\. New \S+ session\.)$/;
export function isSessionNotice(entry: { role: string; text: string }): boolean {
  return entry.role === "system" && SESSION_NOTICE.test(entry.text);
}

export function postTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}
