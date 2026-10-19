import type {
  MuseSettings,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeMode,
} from "@d4research/contracts";
import type { ApprovalChoice, ApprovalRequestParams, ApprovalSubject } from "./MspProtocol.ts";

export function approvalModeForRuntimeMode(
  mode: RuntimeMode,
  override?: MuseSettings["approvalMode"],
) {
  return (
    override ??
    (mode === "full-access"
      ? "allowAll"
      : mode === "approval-required"
        ? "onRequest"
        : "promptUnmatched")
  );
}
function decisionForChoice(choice: ApprovalChoice): ProviderApprovalDecision | undefined {
  if (choice.decision === "denied") return "decline";
  if (choice.decision === "abort") return "cancel";
  if (!["approved", "approvedForSession", "approvedPolicyAmendment"].includes(choice.decision))
    return undefined;
  if (choice.decision === "approvedPolicyAmendment" || choice.scope === "localPersistent")
    return "acceptAlways";
  if (choice.decision === "approvedForSession" || choice.scope === "session")
    return "acceptForSession";
  return choice.scope === "once" ? "accept" : undefined;
}
export function approvalOptionsFromChoices(
  choices: ReadonlyArray<ApprovalChoice>,
): ProviderApprovalOption[] {
  return choices.flatMap((choice) => {
    const decision = decisionForChoice(choice);
    return decision
      ? [
          {
            decision,
            label: choice.label,
            ...(choice.rulePreview ? { warning: choice.rulePreview } : {}),
          },
        ]
      : [];
  });
}
export function selectChoiceForDecision(
  choices: ReadonlyArray<ApprovalChoice>,
  decision: ProviderApprovalDecision,
) {
  const fallbacks =
    decision === "acceptAlways"
      ? ["acceptAlways", "acceptForSession", "accept"]
      : decision === "acceptForSession"
        ? ["acceptForSession", "accept"]
        : decision === "cancel"
          ? ["cancel", "decline"]
          : [decision];
  for (const candidate of fallbacks) {
    const found = choices.find((choice) => decisionForChoice(choice) === candidate);
    if (found) return found;
  }
  return undefined;
}
export function shouldAutoDecide(mode: RuntimeMode, params: ApprovalRequestParams) {
  if (params.protectedWrite || params.judgeEscalated) return false;
  if (!["shell", "fileAccess", "network", "process", "tool"].includes(params.subject.kind))
    return false;
  return (
    mode === "full-access" || (mode === "auto-accept-edits" && params.subject.kind === "fileAccess")
  );
}
export function requestTypeForSubject(subject: ApprovalSubject, protectedWrite: boolean) {
  switch (subject.kind) {
    case "shell":
      return "command_execution_approval";
    case "fileAccess":
      return protectedWrite || subject.access?.toLowerCase().includes("write")
        ? "file_change_approval"
        : "file_read_approval";
    case "network":
    case "process":
    case "tool":
      return "dynamic_tool_call";
    default:
      return "unknown";
  }
}
