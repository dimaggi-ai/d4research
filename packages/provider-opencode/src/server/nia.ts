// @effect-diagnostics nodeBuiltinImport:off -- Native bootstrap is also exercised directly by the subprocess conformance tests.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { D4_AGENT_PREFIX, D4_AGENT_TOOLS } from "@d4research/provider-core/server/d4AgentPolicy";
import type { OpenCodeSettings } from "../settings.ts";

export const niaToolNames = D4_AGENT_TOOLS.map((tool) => `t3-code_${tool}`);
export const niaPermissions = () => [
  { permission: "*", pattern: "*", action: "deny" as const },
  ...niaToolNames.map((permission) => ({ permission, pattern: "*", action: "allow" as const })),
];

// This hook also guards execution: a forged call must not depend on model compliance.
export const niaPluginSource = `export default async () => ({
  "experimental.chat.system.transform": async (_input, output) => {
    output.system.splice(0, output.system.length, ${JSON.stringify(D4_AGENT_PREFIX)});
  },
  "tool.execute.before": async (input) => {
    if (!${JSON.stringify(niaToolNames)}.includes(input.tool)) throw new Error("NIA_TOOL_DENIED");
  }
});\n`;

export function niaEnvironment(
  root: string,
  plugin: string,
  settings: OpenCodeSettings,
  path: string | undefined,
) {
  return {
    ...(path === undefined ? {} : { PATH: path }),
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    OPENCODE_TEST_HOME: root,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      ...settings.config,
      plugin: [plugin],
      instructions: [],
      permission: Object.fromEntries(
        niaPermissions().map((rule) => [rule.permission, rule.action]),
      ),
      agent: { nia: { mode: "primary", prompt: D4_AGENT_PREFIX } },
      default_agent: "nia",
      share: "disabled",
      snapshot: false,
      compaction: { auto: false },
    }),
  };
}

export async function prepareNiaRuntime(input: {
  stateDir: string;
  threadId: string;
  settings: OpenCodeSettings;
  path: string | undefined;
}) {
  // Other platforms have additional managed config sources not covered by this boundary.
  if (process.platform !== "linux") throw new Error("NIA_OPENCODE_PLATFORM_UNVERIFIED");
  // Native session history persists across reconnects, but never shares a home with coding turns.
  const root = join(
    input.stateDir,
    "nia-opencode",
    createHash("sha256").update(input.threadId).digest("hex"),
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  const plugin = join(root, "nia.mjs");
  await writeFile(plugin, niaPluginSource, { mode: 0o600 });
  return {
    directory: root,
    environment: niaEnvironment(root, pathToFileURL(plugin).href, input.settings, input.path),
  };
}

export function requireNiaMcp(status: unknown): void {
  if (typeof status !== "object" || status === null || !("t3-code" in status))
    throw new Error("NIA_MCP_UNAVAILABLE");
  const server = status["t3-code"];
  if (
    typeof server !== "object" ||
    server === null ||
    !("status" in server) ||
    server.status !== "connected"
  )
    throw new Error("NIA_MCP_UNAVAILABLE");
}
