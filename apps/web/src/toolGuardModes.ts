import type { RuntimeMode } from "@d4research/contracts";

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
    description: "Ask before commands and file changes.",
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    profile: "auto-accept-edits",
    policyMode: "enforcement",
    description: "Allow routine edits and ask before riskier actions.",
  },
  auto: {
    label: "Auto",
    profile: "auto",
    policyMode: "enforcement",
    description: "Allow routine work and escalate risky actions.",
  },
  "full-access": {
    label: "Full access",
    profile: "full-access",
    policyMode: "shadow",
    description: "Allow provider actions without approval prompts.",
  },
};
