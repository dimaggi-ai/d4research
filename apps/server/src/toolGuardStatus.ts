import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "./config.ts";
import {
  findToolGuardBinary,
  managedToolGuardPaths,
  readToolGuardManifest,
  TOOL_GUARD_MANAGED_MARKER,
} from "./toolGuardLifecycle.ts";

export type ToolGuardIntegration =
  | "managed"
  | "disabled"
  | "external"
  | "available"
  | "unavailable";

export interface ToolGuardStatus {
  readonly available: boolean;
  readonly integration: ToolGuardIntegration;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly canInstall: boolean;
  readonly canManage: boolean;
  readonly managementSupported: boolean;
  readonly binaryPath: string | null;
  readonly policyProfilesAvailable: boolean;
  readonly message: string;
}

export function classifyToolGuardIntegration(input: {
  readonly binaryAvailable: boolean;
  readonly managedHookDetected: boolean;
  readonly externalHookDetected: boolean;
  readonly installed?: boolean;
  readonly enabled?: boolean;
}): ToolGuardIntegration {
  if (input.installed) return input.enabled ? "managed" : "disabled";
  if (input.managedHookDetected || input.externalHookDetected) return "external";
  if (input.binaryAvailable) return "available";
  return "unavailable";
}

export const readToolGuardStatus = Effect.fn("readToolGuardStatus")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const managed = managedToolGuardPaths(config.stateDir, path);
  const manifest = yield* readToolGuardManifest(managed.manifest);
  const binaryPath = yield* findToolGuardBinary(managed.binary);
  const home = process.env.HOME ?? "";
  const hookConfigPaths = home
    ? [
        path.join(home, ".claude", "settings.json"),
        path.join(home, ".codex", "hooks.json"),
        path.join(home, ".gemini", "config", "hooks.json"),
        path.join(home, ".gemini", "settings.json"),
      ]
    : [];
  const hookConfigs = yield* Effect.forEach(hookConfigPaths, (configPath) =>
    fileSystem.readFileString(configPath).pipe(Effect.orElseSucceed(() => "")),
  );
  const managedHookDetected = hookConfigs.some((content) =>
    content.includes(TOOL_GUARD_MANAGED_MARKER),
  );
  const externalHookDetected = hookConfigs.some(
    (content) =>
      /tool[-_ ]?guard|tg-guard|\/tg hook/iu.test(content) &&
      !content.includes(TOOL_GUARD_MANAGED_MARKER),
  );
  const installed = manifest !== null;
  const enabled = manifest?.enabled === true;
  const policyProfilesAvailable = yield* fileSystem.exists(managed.profiles);
  const managementSupported = process.platform !== "win32";
  const integration = classifyToolGuardIntegration({
    binaryAvailable: binaryPath !== null,
    managedHookDetected,
    externalHookDetected,
    installed,
    enabled,
  });
  const message = !managementSupported
    ? "Managed Tool Guard installation is not yet supported on Windows."
    : integration === "managed"
      ? managedHookDetected
        ? "d2research Tool Guard is installed and enabled."
        : "d2research Tool Guard is enabled, but its provider hooks need repair."
      : integration === "disabled"
        ? "d2research Tool Guard is installed but disabled; native provider permissions are active."
        : integration === "external"
          ? "An external Tool Guard hook is active; d2research will not replace it."
          : integration === "available"
            ? "Tool Guard Core is available. Install the d2research integration to use it."
            : "Tool Guard Core is not available on this machine.";

  return {
    available: binaryPath !== null,
    integration,
    installed,
    enabled,
    canInstall: managementSupported && integration === "available",
    canManage: managementSupported && installed,
    managementSupported,
    binaryPath,
    policyProfilesAvailable,
    message,
  } satisfies ToolGuardStatus;
});
