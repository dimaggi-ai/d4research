import type { RuntimeMode } from "@d4research/contracts";

let toolGuardRuntimeEnabled = false;

export function setToolGuardRuntimeEnabled(enabled: boolean): void {
  toolGuardRuntimeEnabled = enabled;
}

export function toolGuardEnvironment(
  environment: NodeJS.ProcessEnv,
  runtimeMode: RuntimeMode,
): NodeJS.ProcessEnv {
  if (!toolGuardRuntimeEnabled) return environment;
  return {
    ...environment,
    T3RESEARCH_RUNTIME_MODE: runtimeMode,
    T3RESEARCH_TOOL_GUARD_MODE: runtimeMode === "full-access" ? "shadow" : "enforcement",
    T3RESEARCH_TOOL_GUARD_PROFILE: runtimeMode,
  };
}
