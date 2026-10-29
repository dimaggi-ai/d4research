export function d4ActionFailureMessage(error: unknown): string {
  const reason =
    error !== null && typeof error === "object" && "reason" in error ? error.reason : null;
  switch (reason) {
    case "read-only":
      return "Approval is blocked by Nia's current permissions. You can still deny this action.";
    case "action-unavailable":
      return "This action is no longer pending or available. Refresh its status.";
    case "context":
    case "stale":
      return "This action belongs to a different context or session. Refresh its status.";
    case "guard-denied":
      return "Tool Guard blocked this action. Check its details in History.";
    case "disabled":
      return "Nia is disabled. Check its settings.";
    default:
      return "Could not confirm the result. Refresh the action status before trying again.";
  }
}
