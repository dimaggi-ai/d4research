import { tokenizeCliArgs } from "@d4research/shared/cliArgs";

export const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => environment[T3CODE_CODEX_LAUNCH_ARGS_ENV]?.trim() || launchArgs?.trim() || "";

export const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> =>
  tokenizeCliArgs(launchArgs);

/** Codex config path that enables the native `web_search` tool. */
export const CODEX_WEB_SEARCH_CONFIG_KEY = "tools.web_search";
export const CODEX_T3_MCP_TOOL_TIMEOUT_CONFIG_KEY = "mcp_servers.t3-code.tool_timeout_sec";

const hasCodexConfigOverride = (launchArgs: string | undefined, key: string): boolean =>
  codexLaunchArgv(launchArgs).some((arg) => {
    const config = arg.replace(/^(?:--config|-c)=/, "");
    return config.startsWith(`${key}=`);
  });

/**
 * `--search` is a `codex exec`/TUI flag and is rejected by `app-server`, which
 * takes the equivalent as a config override. An explicit `tools.web_search`
 * already present in launch args always wins, so a user can still force it off.
 */
export const codexWebSearchArgs = (
  webSearch: boolean | undefined,
  launchArgs?: string,
): ReadonlyArray<string> => {
  if (webSearch !== true) return [];
  const alreadySet = hasCodexConfigOverride(launchArgs, CODEX_WEB_SEARCH_CONFIG_KEY);
  return alreadySet ? [] : ["-c", `${CODEX_WEB_SEARCH_CONFIG_KEY}=true`];
};

/**
 * Codex otherwise abandons a long `research_delegate` MCP call before the
 * server's own deadline. Explicit launch args win over the generated default.
 */
export const codexT3McpToolTimeoutArgs = (
  launchArgs: string | undefined,
  timeoutSeconds: number,
): ReadonlyArray<string> =>
  hasCodexConfigOverride(launchArgs, CODEX_T3_MCP_TOOL_TIMEOUT_CONFIG_KEY)
    ? []
    : ["-c", `${CODEX_T3_MCP_TOOL_TIMEOUT_CONFIG_KEY}=${Math.ceil(timeoutSeconds)}`];

export const codexAppServerArgs = (launchArgs?: string, webSearch?: boolean) => [
  "app-server",
  ...codexWebSearchArgs(webSearch, launchArgs),
  ...codexLaunchArgv(launchArgs),
];

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};

export const codexSessionAppServerArgs = (
  appServerArgs: ReadonlyArray<string> | undefined,
  launchArgs: string | undefined,
  webSearch?: boolean,
) => {
  const launchAppServerArgs = codexAppServerArgs(launchArgs, webSearch);
  return appServerArgs ? [...launchAppServerArgs, ...appServerArgs] : launchAppServerArgs;
};
