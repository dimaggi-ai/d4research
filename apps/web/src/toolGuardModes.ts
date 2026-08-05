import type { RuntimeMode } from "@t3tools/contracts";

export interface ToolGuardModePresentation {
  readonly label: string;
  readonly profile: "supervised" | "auto-accept-edits" | "auto" | "full-access";
  readonly policyMode: "enforcement" | "shadow";
  readonly description: string;
}

export const TOOL_GUARD_MODE_PRESENTATION: Record<RuntimeMode, ToolGuardModePresentation> = {
  "approval-required": {
    label: "Supervised",
    profile: "supervised",
    policyMode: "enforcement",
    description: "Tool Guard asks before commands and file changes.",
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    profile: "auto-accept-edits",
    policyMode: "enforcement",
    description: "Tool Guard allows routine edits and asks before riskier actions.",
  },
  auto: {
    label: "Auto",
    profile: "auto",
    policyMode: "enforcement",
    description: "Tool Guard enforces local policy and escalates risky actions.",
  },
  "full-access": {
    label: "Full access",
    profile: "full-access",
    policyMode: "shadow",
    description: "Tool Guard audits in shadow mode without blocking provider actions.",
  },
};
