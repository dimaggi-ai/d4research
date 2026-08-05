import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export type ToolGuardIntegration = "managed" | "external" | "available" | "unavailable";

export interface ToolGuardStatus {
  readonly available: boolean;
  readonly integration: ToolGuardIntegration;
  readonly binaryPath: string | null;
  readonly policyProfilesAvailable: boolean;
  readonly message: string;
}

export function classifyToolGuardIntegration(input: {
  readonly binaryAvailable: boolean;
  readonly managedHookDetected: boolean;
  readonly externalHookDetected: boolean;
}): ToolGuardIntegration {
  if (!input.binaryAvailable) return "unavailable";
  if (input.managedHookDetected) return "managed";
  if (input.externalHookDetected) return "external";
  return "available";
}

export const readToolGuardStatus = Effect.fn("readToolGuardStatus")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = process.env.HOME ?? "";
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  const policyProfilesPath = path.join(repositoryRoot, "ops", "tool-guard", "profiles");
  const candidateBinaries = [
    process.env.T3RESEARCH_TOOL_GUARD_BIN,
    home ? path.join(home, "workspace", "github", "tool-guard-core", "bin", "tg") : undefined,
    home ? path.join(home, "tools", "tg-guard", "tg") : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  let binaryPath: string | null = null;
  for (const candidate of candidateBinaries) {
    if (yield* fileSystem.exists(candidate)) {
      binaryPath = candidate;
      break;
    }
  }

  const hookConfigPaths = home
    ? [
        path.join(home, ".claude", "settings.json"),
        path.join(home, ".codex", "hooks.json"),
        path.join(home, ".gemini", "config", "hooks.json"),
      ]
    : [];
  const hookConfigs = yield* Effect.forEach(hookConfigPaths, (configPath) =>
    fileSystem.readFileString(configPath).pipe(Effect.orElseSucceed(() => "")),
  );
  const managedHookDetected = hookConfigs.some((content) =>
    content.includes("t3research-tool-guard-hook"),
  );
  const externalHookDetected = hookConfigs.some(
    (content) => /tool[-_ ]?guard|tg-guard|\/tg hook/iu.test(content) && !managedHookDetected,
  );
  const policyProfilesAvailable = yield* fileSystem.exists(policyProfilesPath);
  const integration = classifyToolGuardIntegration({
    binaryAvailable: binaryPath !== null,
    managedHookDetected,
    externalHookDetected,
  });
  const message =
    integration === "managed"
      ? "T3Research Tool Guard hooks are active."
      : integration === "external"
        ? "An existing Tool Guard hook is active; T3Research will not install a duplicate."
        : integration === "available"
          ? "Tool Guard Core is available and ready for local hook setup."
          : "Tool Guard Core is not available on this machine.";

  return {
    available: binaryPath !== null,
    integration,
    binaryPath,
    policyProfilesAvailable,
    message,
  } satisfies ToolGuardStatus;
});
