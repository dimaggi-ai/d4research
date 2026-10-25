import * as Effect from "effect/Effect";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@d4research/contracts";
import {
  codexThreadRuntimeParams,
  buildCodexTurnStartParams,
} from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  claudeMcpQueryOverrides,
  makeClaudeQueryOptions,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { D4_AGENT_PREFIX, D4_AGENT_TOOLS } from "./policy.ts";
const session = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("agent"),
  providerSessionId: "session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  endpoint: "http://127.0.0.1:4000/mcp",
  authorizationHeader: "Bearer test",
  browserToolsAvailable: false,
};
const policy = {
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
  cwd: "/agent",
  toolPolicy: "d4-agent" as const,
  approvalPolicy: "never",
  sandboxPolicy: { type: "readOnly", networkAccess: false },
};
it.effect("Codex agent disables inherited MCP endpoints and exposes only bounded agent tools", () =>
  Effect.gen(function* () {
    const params = codexThreadRuntimeParams({
      mcpSession: session,
      runtimePolicy: policy,
      modelSelection: { model: "selected" },
      disabledMcpServers: ["dangerous", "t3-code"],
    });
    assert.equal(params.config["features.apps"], false);
    assert.equal(params.config["features.plugins"], false);
    assert.equal(params.config["features.multi_agent"], false);
    for (const feature of [
      "view_image",
      "goals",
      "multi_agent_v2",
      "hooks",
      "codex_hooks",
      "plugin_hooks",
      "skill_search",
      "skill_mcp_dependency_install",
      "memory_tool",
      "external_agent_memory_import",
      "browser_use",
      "computer_use",
      "image_generation",
    ])
      assert.equal(params.config[`features.${feature}`], false);
    assert.equal(params.config["features.skip_host_skill_discovery"], true);
    assert.equal(params.config.project_doc_max_bytes, 0);
    assert.equal(params.config["agents.enabled"], false);
    assert.equal(params.config["skills.include_instructions"], false);
    assert.equal(params.config["skills.bundled.enabled"], false);
    assert.equal(params.baseInstructions, D4_AGENT_PREFIX);
    assert.equal(params.developerInstructions, "");
    assert.deepInclude(params.config.mcp_servers, { dangerous: { enabled: false } });
    const servers = params.config.mcp_servers as Record<
      string,
      { tools?: Record<string, { approval_mode: string }> }
    >;
    assert.deepEqual(
      servers["t3-code"]?.tools,
      Object.fromEntries(D4_AGENT_TOOLS.map((name) => [name, { approval_mode: "approve" }])),
    );
    assert.equal(params.model, "selected");
    const turn = yield* buildCodexTurnStartParams({
      nativeThreadId: "native",
      codexInput: [],
      hasT3Mcp: true,
      appContext: [{ key: "private-app", text: "Private unrelated content" }],
      runtimePolicy: policy,
      modelSelection: { instanceId: session.providerInstanceId, model: "selected" },
    });
    assert.equal(turn.approvalPolicy, "never");
    assert.isUndefined(turn.additionalContext);
    assert.equal(turn.collaborationMode?.settings.developer_instructions, "");
    assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
  }),
);
it("Claude agent cannot inherit native tools, external MCP, or bypass launch flags", () => {
  const mcp = claudeMcpQueryOverrides({
    mcpSession: session,
    readOnlySandbox: true,
    d4AgentOnly: true,
  });
  assert.deepEqual(
    mcp.allowedTools,
    D4_AGENT_TOOLS.map((name) => `mcp__t3-code__${name}`),
  );
  const options = makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    },
    nativeThreadId: "native",
    resume: false,
    cwd: "/agent",
    d4AgentOnly: true,
    tools: ["Bash", "Edit"],
    ...mcp,
  });
  assert.deepEqual(options.tools, []);
  assert.isTrue(options.strictMcpConfig);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.permissionMode, "dontAsk");
  assert.equal(options.systemPrompt, D4_AGENT_PREFIX);
});

it("a normal Codex thread does not inherit a restricted session's deny list", () => {
  const params = codexThreadRuntimeParams({
    mcpSession: session,
    disabledMcpServers: ["ordinary-server"],
    runtimePolicy: { runtimeMode: "approval-required", interactionMode: "default", cwd: "/normal" },
  });
  assert.isFalse(Object.keys(params.config.mcp_servers ?? {}).includes("ordinary-server"));
  assert.isUndefined(params.config["features.apps"]);
});
