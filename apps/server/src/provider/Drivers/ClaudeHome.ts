import type { ClaudeSettings } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@d4research/provider-core/server/pathExpansion";
import * as HostProcess from "@d4research/shared/HostProcess";

type ClaudeEnvironmentConfig = Pick<ClaudeSettings, "configDir" | "homePath">;
const quotePath = Schema.encodeSync(Schema.fromJsonString(Schema.String));

export const resolveClaudeHomePath = Effect.fn("resolveClaudeHomePath")(function* (
  config: ClaudeEnvironmentConfig,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath, home));
  }
  // Inherited env vars are not shell-expanded, so a literal `~` stays literal.
  const inherited = environment?.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (inherited.length > 0) {
    return path.resolve(inherited);
  }
  return path.resolve(path.join(home, ".claude"));
});

export const resolveClaudeConfigDir = Effect.fn("resolveClaudeConfigDir")(function* (
  config: ClaudeEnvironmentConfig,
): Effect.fn.Return<string | undefined, never, Path.Path> {
  const configDir = config.configDir.trim();
  if (configDir.length === 0) return undefined;
  const path = yield* Path.Path;
  return path.resolve(expandHomePath(configDir, yield* HostProcess.HomeDirectory));
});

export const makeClaudeEnvironment = Effect.fn("makeClaudeEnvironment")(function* (
  config: ClaudeEnvironmentConfig,
  baseEnv?: NodeJS.ProcessEnv,
): Effect.fn.Return<NodeJS.ProcessEnv, never, Path.Path> {
  const resolvedBaseEnv = baseEnv ?? process.env;
  const homePath = config.homePath.trim();
  const configDir = config.configDir.trim();
  if (homePath.length === 0 && configDir.length === 0) return resolvedBaseEnv;
  return {
    ...resolvedBaseEnv,
    ...(homePath.length > 0 ? { HOME: yield* resolveClaudeHomePath(config) } : {}),
    ...(configDir.length > 0 ? { CLAUDE_CONFIG_DIR: yield* resolveClaudeConfigDir(config) } : {}),
  };
});

/** managed-mcp.json excludes other MCP config and forbids --strict-mcp-config; omit the flag when present. */
export const hasClaudeManagedMcpConfig = Effect.fn("hasClaudeManagedMcpConfig")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const platform = yield* HostProcess.Platform;
  const managedMcpConfigPath =
    platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-mcp.json"
      : platform === "win32"
        ? "C:\\Program Files\\ClaudeCode\\managed-mcp.json"
        : "/etc/claude-code/managed-mcp.json";
  return yield* fileSystem.exists(managedMcpConfigPath).pipe(Effect.orElseSucceed(() => false));
});

export const makeClaudeContinuationGroupKey = Effect.fn("makeClaudeContinuationGroupKey")(
  function* (
    config: ClaudeEnvironmentConfig,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    const resolvedConfigDir = yield* resolveClaudeConfigDir(config);
    if (resolvedConfigDir) {
      return `claude:config:${resolvedConfigDir}:home:${resolvedHomePath}`;
    }
    return `claude:home:${resolvedHomePath}`;
  },
);

export const makeClaudeCapabilitiesCacheKey = Effect.fn("makeClaudeCapabilitiesCacheKey")(
  function* (
    config: Pick<ClaudeSettings, "binaryPath" | "configDir" | "homePath">,
    cwd?: string,
    environment?: NodeJS.ProcessEnv,
  ): Effect.fn.Return<string, never, Path.Path> {
    const resolvedHomePath = yield* resolveClaudeHomePath(config, environment);
    const resolvedConfigDir = yield* resolveClaudeConfigDir(config);
    return resolvedConfigDir
      ? `${config.binaryPath}\0${resolvedHomePath}\0${resolvedConfigDir}\0${cwd ?? ""}`
      : `${config.binaryPath}\0${resolvedHomePath}\0${cwd ?? ""}`;
  },
);

/** Separate spawn env from login commands to preserve literal paths, including relative inherited values. */
export const claudeSignedOutMessage = (input: {
  readonly configDir: string | undefined;
  readonly cwd: string;
}): string => {
  const configuration =
    input.configDir !== undefined
      ? ` from ${quotePath(input.cwd)}, with CLAUDE_CONFIG_DIR set to ${quotePath(input.configDir)}`
      : "";
  return `Claude could not authenticate. For subscription login, run \`claude auth login\` on this environment's machine${configuration}, then start a new thread. For API-key authentication, check this instance's configured credentials.`;
};
