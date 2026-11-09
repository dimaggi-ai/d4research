import type { RuntimeMode } from "@d4research/contracts";

let toolGuardRuntimeEnabled = false;
let toolGuardHookPath: string | undefined;

export function setToolGuardRuntimeEnabled(enabled: boolean, hookPath?: string): void {
  toolGuardRuntimeEnabled = enabled;
  toolGuardHookPath = enabled ? hookPath : undefined;
}

export function toolGuardEnvironment(
  environment: NodeJS.ProcessEnv,
  runtimeMode: RuntimeMode,
): NodeJS.ProcessEnv {
  if (!toolGuardRuntimeEnabled) return environment;
  return {
    ...environment,
    T3RESEARCH_RUNTIME_MODE: runtimeMode,
    // Full access lifts the provider's own prompts, not the guard: its deny and review
    // rules are then the only check left on destructive and public actions.
    T3RESEARCH_TOOL_GUARD_MODE: "enforcement",
    T3RESEARCH_TOOL_GUARD_PROFILE: runtimeMode,
    // Providers without a native hook config (Pi) call the wrapper themselves.
    ...(toolGuardHookPath === undefined ? {} : { T3RESEARCH_TOOL_GUARD_HOOK: toolGuardHookPath }),
  };
}
