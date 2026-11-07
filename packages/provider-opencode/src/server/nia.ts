import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Digest from "effect/crypto/Digest";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@d4research/shared/HostProcess";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { D4_AGENT_PREFIX, D4_AGENT_TOOLS } from "@d4research/provider-core/server/d4AgentPolicy";
import type { OpenCodeSettings } from "../settings.ts";

const isRuntimeError = Schema.is(OpenCodeRuntime.OpenCodeRuntimeError);
const isConnectedMcp = Schema.is(
  Schema.Struct({ "t3-code": Schema.Struct({ status: Schema.Literal("connected") }) }),
);
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

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

export const niaEnvironment = Effect.fn("Nia.environment")(function* (
  root: string,
  plugin: string,
  settings: OpenCodeSettings,
  environmentPath: string | undefined,
) {
  const path = yield* Path.Path;
  return {
    ...(environmentPath === undefined ? {} : { PATH: environmentPath }),
    HOME: root,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_TEST_HOME: root,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_CONFIG_CONTENT: encodeJson({
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
});

export const prepareNiaRuntime = Effect.fn("Nia.prepareRuntime")(
  function* (input: {
    stateDir: string;
    threadId: string;
    settings: OpenCodeSettings;
    path: string | undefined;
  }) {
    const platform = yield* HostProcess.Platform;
    if (platform !== "linux")
      return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
        operation: "nia",
        detail: "NIA_OPENCODE_PLATFORM_UNVERIFIED",
      });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const digest = yield* Digest.Digest;
    const threadKey = yield* digest.digestHex(
      Digest.sha256,
      new TextEncoder().encode(input.threadId),
    );
    const root = path.join(input.stateDir, "nia-opencode", threadKey);
    yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
    const plugin = path.join(root, "nia.mjs");
    yield* fs.writeFileString(plugin, niaPluginSource, { mode: 0o600 });
    return {
      directory: root,
      environment: yield* niaEnvironment(
        root,
        (yield* path.toFileUrl(plugin)).href,
        input.settings,
        input.path,
      ),
    };
  },
  Effect.mapError((cause) =>
    isRuntimeError(cause)
      ? cause
      : new OpenCodeRuntime.OpenCodeRuntimeError({
          operation: "nia",
          detail: "NIA_RUNTIME_PREPARATION_FAILED",
          cause,
        }),
  ),
);

export function requireNiaMcp(status: unknown): void {
  if (!isConnectedMcp(status)) throw new Error("NIA_MCP_UNAVAILABLE");
}
