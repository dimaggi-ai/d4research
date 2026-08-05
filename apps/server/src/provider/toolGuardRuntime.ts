import type { RuntimeMode } from "@t3tools/contracts";

export function toolGuardEnvironment(
  environment: NodeJS.ProcessEnv,
  runtimeMode: RuntimeMode,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    T3RESEARCH_RUNTIME_MODE: runtimeMode,
    T3RESEARCH_TOOL_GUARD_MODE: runtimeMode === "full-access" ? "shadow" : "enforcement",
    T3RESEARCH_TOOL_GUARD_PROFILE: runtimeMode,
  };
}
