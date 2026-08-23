import { ClaudeSettings } from "@d4research/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES,
  getBuiltInClaudeModelsForEnvironment,
  claudeUsesLocalOllama,
  isLegacyClaudeModel,
  mapClaudeUsage,
  parseOllamaModelList,
  parseOllamaTagsPayload,
  probeClaudeCapabilities,
} from "./ClaudeProvider.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it("keeps only the Claude 5 family out of legacy models", () => {
  assert.deepStrictEqual(
    ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8"].map((model) => [
      model,
      isLegacyClaudeModel(model),
    ]),
    [
      ["claude-fable-5", false],
      ["claude-opus-5", false],
      ["claude-sonnet-5", false],
      ["claude-opus-4-8", true],
    ],
  );
});

it("discovers locally installed Ollama models only for the local Ollama endpoint", () => {
  assert.deepStrictEqual(
    parseOllamaModelList(
      "NAME ID SIZE MODIFIED\nqwen3.5:latest abc 4 GB today\ngemma3:27b def 17 GB yesterday\nqwen3.5:latest abc 4 GB today\n",
    ),
    ["qwen3.5:latest", "gemma3:27b"],
  );
  assert.equal(claudeUsesLocalOllama({ ANTHROPIC_BASE_URL: "http://127.0.0.1:11434" }), true);
  assert.equal(claudeUsesLocalOllama({ ANTHROPIC_BASE_URL: "https://ollama.example" }), false);
  assert.deepStrictEqual(
    getBuiltInClaudeModelsForEnvironment({ ANTHROPIC_BASE_URL: "http://127.0.0.1:11434" }, "2.1.0"),
    [],
  );
  assert.ok(getBuiltInClaudeModelsForEnvironment({}, "2.1.0").length > 0);
});

it("keeps Ollama `:cloud` tags when parsing either discovery source", () => {
  // Real `ollama list` output: cloud entries carry "-" as their size column.
  assert.deepStrictEqual(
    parseOllamaModelList(
      [
        "NAME                     ID              SIZE      MODIFIED",
        "glm-5.2:cloud            ce8fd6f94793    -         9 days ago",
        "gpt-oss:20b-cloud        875e8e3a629a    -         9 days ago",
        "gemma4:e4b               c6eb396dbd59    9.6 GB    3 months ago",
      ].join("\n"),
    ),
    ["glm-5.2:cloud", "gpt-oss:20b-cloud", "gemma4:e4b"],
  );
  assert.deepStrictEqual(
    parseOllamaTagsPayload({
      models: [
        { name: "glm-5.2:cloud", model: "glm-5.2:cloud", remote_host: "https://ollama.com:443" },
        { model: "gemma4:e4b" },
        { name: "glm-5.2:cloud" },
        { name: "" },
        null,
      ],
    }),
    ["glm-5.2:cloud", "gemma4:e4b"],
  );
  assert.deepStrictEqual(parseOllamaTagsPayload({ models: "nope" }), []);
  assert.deepStrictEqual(parseOllamaTagsPayload(undefined), []);
});

it("recognizes the endpoint `ollama launch claude` configures, in every spelling", () => {
  // Exactly what ollama 0.32.4 exports.
  assert.equal(
    claudeUsesLocalOllama({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:11434",
      ANTHROPIC_AUTH_TOKEN: "ollama",
      ANTHROPIC_API_KEY: "",
    }),
    true,
  );
  for (const baseUrl of [
    "http://localhost:11434",
    "http://127.0.0.1:11434/",
    "http://[::1]:11434",
    "  http://127.0.0.1:11434  ",
  ]) {
    assert.equal(claudeUsesLocalOllama({ ANTHROPIC_BASE_URL: baseUrl }), true, baseUrl);
  }
  // A non-default port still counts when the Ollama sentinel token is present.
  assert.equal(
    claudeUsesLocalOllama({
      ANTHROPIC_BASE_URL: "http://127.0.0.1:11437",
      ANTHROPIC_AUTH_TOKEN: "ollama",
    }),
    true,
  );
  assert.equal(claudeUsesLocalOllama({ ANTHROPIC_BASE_URL: "http://127.0.0.1:11437" }), false);
  for (const baseUrl of [
    "https://api.anthropic.com",
    "http://192.168.4.34:11434",
    "http://127.0.0.1:11434/v1",
    "not-a-url",
    "",
  ]) {
    assert.equal(claudeUsesLocalOllama({ ANTHROPIC_BASE_URL: baseUrl }), false, baseUrl);
  }
  assert.equal(claudeUsesLocalOllama({}), false);
});

it("isolates Claude capability probes without dropping workspace setting sources", () => {
  const abortController = new AbortController();
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController,
    environment: {
      HOME: "/home/user",
      ENABLE_CLAUDEAI_MCP_SERVERS: "true",
    },
    cwd: "/workspace/project",
  });

  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.cwd, "/workspace/project");
  assert.deepEqual(options.settingSources, [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES]);
  assert.deepEqual(options.allowedTools, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.pathToClaudeCodeExecutable, "/usr/bin/claude");
  assert.equal(options.abortController, abortController);
  assert.equal(options.env?.HOME, "/home/user");
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

it("maps supported and unsupported Claude usage limits", () => {
  const checkedAt = "2026-08-05T12:00:00.000Z";
  const session = {
    total_cost_usd: 0,
    total_api_duration_ms: 0,
    total_duration_ms: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
    model_usage: {},
  };

  assert.deepStrictEqual(
    mapClaudeUsage(
      {
        session,
        subscription_type: "max",
        rate_limits_available: true,
        behaviors: null,
        rate_limits: {
          five_hour: { utilization: 42.5, resets_at: "2026-08-05T15:00:00.000Z" },
          seven_day: { utilization: null, resets_at: null },
          seven_day_opus: { utilization: 10, resets_at: "2026-08-09T00:00:00.000Z" },
        },
      },
      checkedAt,
    ),
    {
      support: "supported",
      planType: "max",
      windows: [
        {
          id: "five_hour",
          label: "5-hour",
          utilizationPercent: 42.5,
          resetsAt: "2026-08-05T15:00:00.000Z",
          windowMinutes: null,
        },
        {
          id: "seven_day",
          label: "Weekly",
          utilizationPercent: null,
          resetsAt: null,
          windowMinutes: null,
        },
        {
          id: "seven_day_opus",
          label: "Weekly (Opus)",
          utilizationPercent: 10,
          resetsAt: "2026-08-09T00:00:00.000Z",
          windowMinutes: null,
        },
      ],
      limitReached: null,
      checkedAt,
      message: null,
    },
  );

  assert.deepStrictEqual(
    mapClaudeUsage(
      {
        session,
        subscription_type: null,
        rate_limits_available: false,
        behaviors: null,
        rate_limits: null,
      },
      checkedAt,
    ),
    {
      support: "unsupported",
      planType: null,
      windows: [],
      limitReached: null,
      checkedAt,
      message: null,
    },
  );
});

it.layer(NodeServices.layer)("Claude capability probe SDK boundary", (it) => {
  it.effect("serializes strict no-MCP options and still resolves account capabilities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-sdk-" });
      const executablePath = path.join(tempDir, "fake-claude.mjs");
      const invocationPath = path.join(tempDir, "invocation.json");
      const workspaceCwd = path.join(tempDir, "workspace");
      yield* fs.makeDirectory(workspaceCwd, { recursive: true });

      yield* fs.writeFileString(
        executablePath,
        [
          "#!/usr/bin/env node",
          'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
          'import { createInterface } from "node:readline";',
          "const args = process.argv.slice(2);",
          'const mcpConfigIndex = args.indexOf("--mcp-config");',
          "const rawMcpConfig = mcpConfigIndex >= 0 ? args[mcpConfigIndex + 1] : undefined;",
          "let mcpConfig;",
          "if (rawMcpConfig) {",
          '  const contents = existsSync(rawMcpConfig) ? readFileSync(rawMcpConfig, "utf8") : rawMcpConfig;',
          "  try { mcpConfig = JSON.parse(contents); } catch { mcpConfig = contents; }",
          "}",
          "writeFileSync(process.env.T3_PROBE_INVOCATION_PATH, JSON.stringify({",
          "  args,",
          "  cwd: process.cwd(),",
          "  connectorEnv: process.env.ENABLE_CLAUDEAI_MCP_SERVERS,",
          "  mcpConfig,",
          "}));",
          "const lines = createInterface({ input: process.stdin });",
          'lines.on("line", (line) => {',
          "  const message = JSON.parse(line);",
          '  if (message.type === "control_request" && message.request?.subtype === "get_usage") {',
          "    process.stdout.write(JSON.stringify({",
          '      type: "control_response",',
          "      response: {",
          '        subtype: "success",',
          "        request_id: message.request_id,",
          "        response: {",
          "          session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },",
          '          subscription_type: "pro",',
          "          rate_limits_available: true,",
          '          rate_limits: { five_hour: { utilization: 25, resets_at: "2026-08-05T15:00:00.000Z" } },',
          "        },",
          "      },",
          '    }) + "\\n");',
          "    return;",
          "  }",
          '  if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;',
          "  process.stdout.write(JSON.stringify({",
          '    type: "control_response",',
          "    response: {",
          '      subtype: "success",',
          "      request_id: message.request_id,",
          "      response: {",
          '        commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],',
          "        agents: [],",
          '        output_style: "default",',
          '        available_output_styles: ["default"],',
          "        models: [],",
          '        account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },',
          "      },",
          "    },",
          '  }) + "\\n");',
          "});",
          "setInterval(() => {}, 1_000);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(executablePath, 0o755);

      const capabilities = yield* probeClaudeCapabilities(
        decodeClaudeSettings({ binaryPath: executablePath }),
        {
          ...process.env,
          T3_PROBE_INVOCATION_PATH: invocationPath,
          ENABLE_CLAUDEAI_MCP_SERVERS: "true",
        },
        workspaceCwd,
      );
      assert.ok(capabilities);
      assert.ok(capabilities.usage);
      assert.match(capabilities.usage.checkedAt, /^\d{4}-\d{2}-\d{2}T/u);

      assert.deepEqual(capabilities, {
        email: "dev@example.com",
        subscriptionType: "pro",
        tokenSource: "oauth",
        apiProvider: undefined,
        slashCommands: [
          {
            name: "review",
            description: "Review changes",
            input: { hint: "[path]" },
          },
        ],
        usage: {
          support: "supported",
          planType: "pro",
          windows: [
            {
              id: "five_hour",
              label: "5-hour",
              utilizationPercent: 25,
              resetsAt: "2026-08-05T15:00:00.000Z",
              windowMinutes: null,
            },
          ],
          limitReached: null,
          checkedAt: capabilities.usage.checkedAt,
          message: null,
        },
      });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const invocation = JSON.parse(yield* fs.readFileString(invocationPath)) as {
        readonly args: ReadonlyArray<string>;
        readonly cwd: string;
        readonly connectorEnv: string;
        readonly mcpConfig: unknown;
      };
      assert.equal(invocation.cwd, yield* fs.realPath(workspaceCwd));
      assert.equal(invocation.connectorEnv, "false");
      assert.equal(invocation.args.includes("--strict-mcp-config"), true);
      assert.equal(invocation.args.includes("--mcp-config"), false);
      assert.equal(invocation.mcpConfig, undefined);

      assert.equal(invocation.args.includes("--setting-sources=user,project,local"), true);
    }).pipe(Effect.scoped),
  );
});
