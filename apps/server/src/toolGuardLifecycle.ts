// @effect-diagnostics preferSchemaOverJson:off
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "./config.ts";
import { setToolGuardRuntimeEnabled } from "./provider/toolGuardRuntime.ts";

export const TOOL_GUARD_MANAGED_MARKER = "d4research-tool-guard-managed";
export const TOOL_GUARD_CORE_URL = "https://github.com/dimaggi-ai/tool-guard-core";

export const ToolGuardLifecycleAction = [
  "install",
  "replace-external",
  "enable",
  "disable",
  "uninstall",
] as const;
export type ToolGuardLifecycleAction = (typeof ToolGuardLifecycleAction)[number];

interface JsonObject {
  [key: string]: unknown;
}

export interface ToolGuardManagedPaths {
  readonly root: string;
  readonly manifest: string;
  readonly binary: string;
  readonly hook: string;
  readonly agyHook: string;
  readonly profiles: string;
}

const toolGuardHome = (platform: NodeJS.Platform, environment: NodeJS.ProcessEnv) =>
  platform === "win32"
    ? (environment.USERPROFILE ?? environment.HOME ?? "")
    : (environment.HOME ?? "");

export interface ToolGuardLifecycleResult {
  readonly ok: boolean;
  readonly message: string;
}

export function managedToolGuardPaths(
  stateDir: string,
  path: Pick<Path.Path, "join">,
  platform: NodeJS.Platform,
): ToolGuardManagedPaths {
  const root = path.join(stateDir, "tool-guard", "integration");
  const windows = platform === "win32";
  return {
    root,
    manifest: path.join(root, "manifest.json"),
    binary: path.join(root, "bin", windows ? "tg.exe" : "tg"),
    hook: path.join(root, "scripts", `t3research-tool-guard-hook${windows ? ".ps1" : ""}`),
    agyHook: path.join(root, "scripts", `t3research-tool-guard-agy-hook${windows ? ".ps1" : ""}`),
    profiles: path.join(root, "profiles"),
  };
}

export function managedToolGuardCommand(hookPath: string, platform: NodeJS.Platform) {
  if (platform !== "win32") return hookPath;
  const escaped = hookPath.replaceAll('"', '\\"');
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${escaped}"`;
}

function objectValue(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

export function addManagedHook(config: unknown, hookPath: string): JsonObject {
  const root = { ...objectValue(config) };
  const hooks = { ...objectValue(root.hooks) };
  const existing = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  if (!existing.some((entry) => JSON.stringify(entry).includes(TOOL_GUARD_MANAGED_MARKER))) {
    hooks.PreToolUse = [
      ...existing,
      {
        matcher:
          "Bash|Edit|Write|NotebookEdit|run_command|write_to_file|replace_file_content|multi_replace_file_content",
        hooks: [
          {
            type: "command",
            command: hookPath,
            timeout: 30,
            marker: TOOL_GUARD_MANAGED_MARKER,
          },
        ],
      },
    ];
  }
  root.hooks = hooks;
  return root;
}

export function removeManagedHook(config: unknown): JsonObject {
  const root = { ...objectValue(config) };
  const hooks = { ...objectValue(root.hooks) };
  if (Array.isArray(hooks.PreToolUse)) {
    const remaining = hooks.PreToolUse.filter(
      (entry) => !JSON.stringify(entry).includes(TOOL_GUARD_MANAGED_MARKER),
    );
    if (remaining.length === 0) delete hooks.PreToolUse;
    else hooks.PreToolUse = remaining;
  }
  if (Object.keys(hooks).length === 0) delete root.hooks;
  else root.hooks = hooks;
  return root;
}

const isExternalToolGuardEntry = (entry: unknown) => {
  const serialized = JSON.stringify(entry);
  return (
    /tool[-_ ]?guard|tg-guard|[/\\]tg(?:\.exe)?\s+hook/iu.test(serialized) &&
    !serialized.includes(TOOL_GUARD_MANAGED_MARKER)
  );
};

export function removeExternalToolGuardHooks(config: unknown): JsonObject {
  const root = { ...objectValue(config) };
  const hooks = { ...objectValue(root.hooks) };
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const remaining = entries.filter((entry) => !isExternalToolGuardEntry(entry));
    if (remaining.length === 0) delete hooks[event];
    else hooks[event] = remaining;
  }
  if (Object.keys(hooks).length === 0) delete root.hooks;
  else root.hooks = hooks;
  return root;
}

const parseJsonObject = (content: string): JsonObject => {
  return objectValue(JSON.parse(content));
};

const readJson = Effect.fn("readToolGuardJson")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const content = yield* fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => "{}"));
  return parseJsonObject(content);
});

const writeJson = Effect.fn("writeToolGuardJson")(function* (filePath: string, value: JsonObject) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, `${JSON.stringify(value, null, 2)}\n`);
});

export const providerHookPaths = (home: string, path: Pick<Path.Path, "join">) => [
  path.join(home, ".claude", "settings.json"),
  path.join(home, ".codex", "hooks.json"),
  path.join(home, ".gemini", "config", "hooks.json"),
];

export const externalToolGuardHookPaths = (home: string, path: Pick<Path.Path, "join">) => [
  ...providerHookPaths(home, path),
  path.join(home, ".gemini", "settings.json"),
];

const hasExternalToolGuardHook = Effect.fn("hasExternalToolGuardHook")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const home = toolGuardHome(platform, environment);
  if (!home) return false;
  const contents = yield* Effect.forEach(externalToolGuardHookPaths(home, path), (configPath) =>
    fileSystem.readFileString(configPath).pipe(Effect.orElseSucceed(() => "")),
  );
  return contents.some(
    (content) =>
      /tool[-_ ]?guard|tg-guard|\/tg hook/iu.test(content) &&
      !content.includes(TOOL_GUARD_MANAGED_MARKER),
  );
});

const removeExternalToolGuardHooksFromConfigs = Effect.fn(
  "removeExternalToolGuardHooksFromConfigs",
)(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const home = toolGuardHome(platform, environment);
  if (!home) return;
  yield* Effect.forEach(
    externalToolGuardHookPaths(home, path),
    (configPath) =>
      Effect.gen(function* () {
        if (!(yield* fileSystem.exists(configPath))) return;
        const current = yield* readJson(configPath);
        const next = removeExternalToolGuardHooks(current);
        if (JSON.stringify(current) !== JSON.stringify(next)) yield* writeJson(configPath, next);
      }),
    { discard: true },
  );
});

const setManagedHooksEnabled = Effect.fn("setManagedHooksEnabled")(function* (
  enabled: boolean,
  hookPath: string,
  agyHookPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const home = toolGuardHome(platform, environment);
  if (!home) return;
  yield* Effect.forEach(
    providerHookPaths(home, path),
    (configPath) =>
      Effect.gen(function* () {
        if (!enabled && !(yield* fileSystem.exists(configPath))) return;
        const current = yield* readJson(configPath);
        const providerHookPath = configPath.includes(`${path.sep}.gemini${path.sep}`)
          ? agyHookPath
          : hookPath;
        const providerHookCommand = managedToolGuardCommand(providerHookPath, platform);
        const next = enabled
          ? addManagedHook(current, providerHookCommand)
          : removeManagedHook(current);
        yield* writeJson(configPath, next);
      }),
    { discard: true },
  );
});

const validateProviderHookConfigs = Effect.fn("validateProviderHookConfigs")(function* () {
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const home = toolGuardHome(platform, environment);
  if (!home) return;
  yield* Effect.forEach(externalToolGuardHookPaths(home, path), readJson, { discard: true });
});

export const findToolGuardBinary = Effect.fn("findToolGuardBinary")(function* (
  managedBinary?: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const home = toolGuardHome(platform, environment);
  const binaryName = platform === "win32" ? "tg.exe" : "tg";
  const pathSeparator = platform === "win32" ? ";" : ":";
  const pathCandidates = (environment.PATH ?? "")
    .split(pathSeparator)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .map((entry) => path.join(entry, binaryName));
  const candidates = [
    managedBinary,
    environment.T3RESEARCH_TOOL_GUARD_BIN,
    ...pathCandidates,
    home ? path.join(home, "workspace", "github", "tool-guard-core", "bin", binaryName) : undefined,
    home ? path.join(home, "tools", "tg-guard", binaryName) : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (yield* fileSystem.exists(candidate)) return candidate;
  }
  return null;
});

const resolveResources = Effect.fn("resolveToolGuardResources")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const environment = yield* HostProcessEnvironment;
  const bundled = path.join(import.meta.dirname, "tool-guard");
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  const profilesCandidates = [
    environment.D4RESEARCH_TOOL_GUARD_RESOURCES
      ? path.join(environment.D4RESEARCH_TOOL_GUARD_RESOURCES, "profiles")
      : undefined,
    path.join(bundled, "profiles"),
    path.join(repositoryRoot, "ops", "tool-guard", "profiles"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const scriptsCandidates = [
    environment.D4RESEARCH_TOOL_GUARD_RESOURCES
      ? path.join(environment.D4RESEARCH_TOOL_GUARD_RESOURCES, "scripts")
      : undefined,
    path.join(bundled, "scripts"),
    path.join(repositoryRoot, "scripts"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  let profiles: string | undefined;
  for (const candidate of profilesCandidates) {
    if (yield* fileSystem.exists(candidate)) {
      profiles = candidate;
      break;
    }
  }
  let scripts: string | undefined;
  const hookName = `t3research-tool-guard-hook${platform === "win32" ? ".ps1" : ""}`;
  for (const candidate of scriptsCandidates) {
    if (yield* fileSystem.exists(path.join(candidate, hookName))) {
      scripts = candidate;
      break;
    }
  }
  return { profiles, scripts };
});

export const readToolGuardManifest = Effect.fn("readToolGuardManifest")(function* (
  manifestPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  if (!(yield* fileSystem.exists(manifestPath))) return null;
  const value = yield* readJson(manifestPath);
  return {
    enabled: value.enabled === true,
    installedAt: typeof value.installedAt === "string" ? value.installedAt : null,
  };
});

export const initializeToolGuardRuntime = Effect.fn("initializeToolGuardRuntime")(function* () {
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcessPlatform;
  const managed = managedToolGuardPaths(config.stateDir, path, platform);
  const manifest = yield* readToolGuardManifest(managed.manifest);
  setToolGuardRuntimeEnabled(manifest?.enabled === true);
});

export const manageToolGuard = Effect.fn("manageToolGuard")(
  function* (action: ToolGuardLifecycleAction) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const platform = yield* HostProcessPlatform;
    const managed = managedToolGuardPaths(config.stateDir, path, platform);
    const manifest = yield* readToolGuardManifest(managed.manifest);
    yield* validateProviderHookConfigs();

    if (action === "install" || action === "replace-external") {
      if (manifest) return { ok: true, message: "d4research Tool Guard is already installed." };
      const externalHookDetected = yield* hasExternalToolGuardHook();
      if (action === "install" && externalHookDetected) {
        return {
          ok: false,
          message:
            "An external Tool Guard hook is already configured. Remove it before installing the d4research-managed integration.",
        };
      }
      const sourceBinary = yield* findToolGuardBinary();
      if (!sourceBinary) {
        return {
          ok: false,
          message: `Tool Guard Core was not found. Install it from ${TOOL_GUARD_CORE_URL}/releases or set T3RESEARCH_TOOL_GUARD_BIN, then retry.`,
        };
      }
      const resources = yield* resolveResources();
      if (!resources.profiles || !resources.scripts) {
        return {
          ok: false,
          message: "This d4research build does not contain Tool Guard resources.",
        };
      }
      if (action === "replace-external" && !externalHookDetected) {
        return { ok: false, message: "No external Tool Guard hook was found to replace." };
      }
      yield* fileSystem.makeDirectory(path.dirname(managed.binary), { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(managed.hook), { recursive: true });
      yield* fileSystem.copyFile(sourceBinary, managed.binary);
      yield* fileSystem.chmod(managed.binary, 0o755);
      yield* fileSystem.copy(resources.profiles, managed.profiles, { overwrite: true });
      yield* fileSystem.copyFile(
        path.join(
          resources.scripts,
          `t3research-tool-guard-hook${platform === "win32" ? ".ps1" : ""}`,
        ),
        managed.hook,
      );
      yield* fileSystem.copyFile(
        path.join(
          resources.scripts,
          `t3research-tool-guard-agy-hook${platform === "win32" ? ".ps1" : ""}`,
        ),
        managed.agyHook,
      );
      if (platform !== "win32") {
        yield* fileSystem.chmod(managed.hook, 0o755);
        yield* fileSystem.chmod(managed.agyHook, 0o755);
      }
      if (action === "replace-external") yield* removeExternalToolGuardHooksFromConfigs();
      const installedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      yield* writeJson(managed.manifest, {
        version: 1,
        enabled: true,
        installedAt,
      });
      yield* setManagedHooksEnabled(true, managed.hook, managed.agyHook);
      setToolGuardRuntimeEnabled(true);
      return { ok: true, message: "d4research Tool Guard was installed and enabled." };
    }

    if (!manifest) return { ok: false, message: "d4research Tool Guard is not installed." };

    if (action === "enable") {
      yield* writeJson(managed.manifest, { ...manifest, version: 1, enabled: true });
      yield* setManagedHooksEnabled(true, managed.hook, managed.agyHook);
      setToolGuardRuntimeEnabled(true);
      return { ok: true, message: "d4research Tool Guard is enabled." };
    }

    yield* setManagedHooksEnabled(false, managed.hook, managed.agyHook);
    if (action === "disable") {
      yield* writeJson(managed.manifest, { ...manifest, version: 1, enabled: false });
      setToolGuardRuntimeEnabled(false);
      return {
        ok: true,
        message: "d4research Tool Guard is disabled; native provider permissions are active.",
      };
    }

    yield* fileSystem.remove(managed.root, { recursive: true, force: true });
    setToolGuardRuntimeEnabled(false);
    return { ok: true, message: "d4research Tool Guard was uninstalled." };
  },
  Effect.catchCause((cause) =>
    Effect.succeed({
      ok: false,
      message: `Tool Guard lifecycle action failed: ${String(cause)}`,
    }),
  ),
);
