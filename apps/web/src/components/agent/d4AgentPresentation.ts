import type { D4AgentState, D4AgentSystemCheck } from "@d4research/contracts";

export function systemCheckLabel(check: D4AgentSystemCheck): string {
  return {
    "user-units": "User services",
    "root-disk": "Root disk",
    "data-disk": "Data disk",
    server: "Server health",
  }[check.id];
}
export function systemCheckStatus(check: D4AgentSystemCheck): string {
  if (check.status === "unavailable") return "Not available";
  if (check.status === "disabled") return "Off";
  const status = check.status === "attention" ? "Needs attention" : "Healthy";
  if (check.value === null) return status;
  if (check.id === "root-disk" || check.id === "data-disk")
    return `${status} · ${check.value}% used`;
  if (check.id === "user-units") return `${status} · ${check.value} failed services`;
  return status;
}
export function agentUnavailableMessage(reason: D4AgentState["unavailableReason"]): string {
  switch (reason) {
    case "disabled":
      return "Agent chat is off. Enable it in Settings → General → d4 Agent.";
    case "model-not-selected":
      return "Choose an agent model in Settings → General → d4 Agent.";
    case "provider-unavailable":
      return "The selected provider is unavailable. Check its connection in Settings.";
    case "model-unavailable":
      return "The selected model is unavailable. Choose an available model in Settings → General → d4 Agent.";
    case "option-unavailable":
      return "The selected model options are unavailable. Update them in Settings → General → d4 Agent.";
    case "sandbox-unavailable":
      return "The selected provider cannot enforce the agent permissions. Choose a supported provider in Settings → General → d4 Agent.";
    case null:
      return "";
  }
}
