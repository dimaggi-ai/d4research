// @effect-diagnostics preferSchemaOverJson:off -- Fixtures assert raw JSON wire values and provider output.
// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@d4research/contracts";
import * as NodeFSP from "node:fs/promises";
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
  probeClaudeWorkspaceSnapshot,
} from "./ClaudeProvider.ts";
import { COMPACT_SLASH_COMMAND } from "./providerSnapshot.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

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
  assert.deepEqual(options.settings, { disableAllHooks: true });
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

  assert.deepStrictEqual(
    mapClaudeUsage(
      {
        subscription_type: "max",
        rate_limits_available: true,
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
        subscription_type: null,
        rate_limits_available: false,
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
  it.effect(
    "discovers commands and skills separately for each cwd without replacing machine metadata",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-workspaces-" });
        const configDir = path.join(tempDir, "claude-home");
        const workspaces = [path.join(tempDir, "one"), path.join(tempDir, "two")];
        for (const cwd of workspaces) {
          const skillDir = path.join(cwd, ".claude", "skills", "existing-skill");
          yield* fs.makeDirectory(skillDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(skillDir, "SKILL.md"),
            "---\nname: existing-skill\ndescription: Existing project skill\n---\nUse this skill.",
          );
        }
        const machineSnapshot = {
          instanceId: ProviderInstanceId.make("claude"),
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated", email: "machine@example.com" },
          checkedAt: "2026-03-25T00:00:00.000Z",
          version: "2.1.288",
          models: [],
          slashCommands: [{ name: "server-cwd-only" }],
          skills: [],
        } satisfies ServerProvider;
        let usageCalls = 0;
        const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
          assert.equal(options?.env?.CLAUDE_CONFIG_DIR, configDir);
          assert.equal(options?.env?.T3_WORKSPACE_PROBE, "owned-instance");
          return {
            initializationResult: async () => ({
              account: { email: "workspace@example.com" },
              commands: [
                {
                  name: options?.cwd === workspaces[0] ? "start-session" : "other-project",
                  description: "Project command",
                  argumentHint: "[topic]",
                },
                { name: "nested:review", description: "Review changes", argumentHint: "" },
                { name: "NESTED:review", description: "", argumentHint: "[path]" },
                { name: "compact", description: "Provider compact", argumentHint: "" },
                { name: "user-command", description: "Existing user command", argumentHint: "" },
              ],
            }),
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
              usageCalls++;
              return { rate_limits_available: false, rate_limits: null };
            },
          } as ReturnType<typeof ClaudeSdk.query>;
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
        for (const [index, cwd] of workspaces.entries()) {
          const scoped = yield* probeClaudeWorkspaceSnapshot(
            decodeClaudeSettings({ homePath: configDir }),
            machineSnapshot,
            cwd,
            { ...process.env, T3_WORKSPACE_PROBE: "owned-instance" },
          );
          assert.deepEqual(scoped, {
            ...machineSnapshot,
            slashCommandsPending: false,
            slashCommands: [
              COMPACT_SLASH_COMMAND,
              {
                name: index === 0 ? "start-session" : "other-project",
                description: "Project command",
                input: { hint: "[topic]" },
              },
              { name: "nested:review", description: "Review changes", input: { hint: "[path]" } },
              { name: "user-command", description: "Existing user command" },
            ],
            skills: [
              {
                name: "existing-skill",
                path: path.join(cwd, ".claude", "skills", "existing-skill", "SKILL.md"),
                enabled: true,
                scope: "project",
                description: "Existing project skill",
              },
            ],
          });
        }
        assert.deepEqual(
          query.mock.calls.map(([input]) => input.options?.cwd),
          workspaces,
        );
        assert.equal(usageCalls, 0);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps readable skills during failed command discovery and recovers on retry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-workspace-retry-" });
      const skillDir = path.join(cwd, ".claude", "skills", "existing-skill");
      yield* fs.makeDirectory(skillDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(skillDir, "SKILL.md"),
        "---\nname: existing-skill\ndescription: Existing project skill\n---\nUse this skill.",
      );
      const machineSnapshot = {
        instanceId: ProviderInstanceId.make("claude"),
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-03-25T00:00:00.000Z",
        version: "2.1.288",
        models: [],
        slashCommands: [{ name: "server-cwd-only" }],
        skills: [],
      } satisfies ServerProvider;
      const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(
        () =>
          ({
            initializationResult: () =>
              Promise.reject<ClaudeSdk.SDKControlInitializeResponse>(
                new Error("Initialization failed"),
              ),
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
              rate_limits_available: false,
              rate_limits: null,
            }),
          }) as ReturnType<typeof ClaudeSdk.query>,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
      const settings = decodeClaudeSettings({ homePath: cwd });
      const failed = yield* probeClaudeWorkspaceSnapshot(settings, machineSnapshot, cwd);
      assert.deepEqual(failed, {
        ...machineSnapshot,
        slashCommands: [COMPACT_SLASH_COMMAND],
        slashCommandsPending: true,
        skills: [
          {
            name: "existing-skill",
            path: path.join(skillDir, "SKILL.md"),
            enabled: true,
            scope: "project",
            description: "Existing project skill",
          },
        ],
      });
      query.mockImplementation(
        () =>
          ({
            initializationResult: async () => ({
              commands: [{ name: "recovered", description: "", argumentHint: "" }],
            }),
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
              rate_limits_available: false,
              rate_limits: null,
            }),
          }) as ReturnType<typeof ClaudeSdk.query>,
      );
      const recovered = yield* probeClaudeWorkspaceSnapshot(settings, machineSnapshot, cwd);
      assert.deepEqual(recovered.slashCommands, [COMPACT_SLASH_COMMAND, { name: "recovered" }]);
      assert.equal(recovered.status, "ready");
      assert.equal(recovered.slashCommandsPending, false);
      assert.deepEqual(recovered.skills, failed.skills);
      const disabled = yield* probeClaudeWorkspaceSnapshot(
        { ...settings, enabled: false },
        machineSnapshot,
        cwd,
      );
      assert.equal(disabled, machineSnapshot);
      assert.equal(query.mock.calls.length, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("serializes strict no-MCP options and still resolves account capabilities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-sdk-" });
      const executablePath = yield* path.fromFileUrl(
        new URL("./testing/ClaudeCapabilitiesProbe.fixture.mjs", import.meta.url),
      );
      const invocationPath = path.join(tempDir, "invocation.json");
      // The probe aborts the SDK without awaiting the child's exit, and on
      // Windows a directory that is still some process's cwd cannot be
      // removed. Keep the workspace outside the scoped directory and let it
      // go with a retrying removal once the child has gone.
      const workspaceCwd = yield* fs.makeTempDirectory({ prefix: "t3-claude-probe-cwd-" });
      // Node's own retry rather than an Effect schedule: it.effect runs on a
      // TestClock, so a scheduled retry would wait for time nobody advances.
      // If the child still holds the directory after that, an empty temp
      // directory is left behind rather than failing the test for it.
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          NodeFSP.rm(workspaceCwd, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 250,
          }).catch(() => undefined),
        ),
      );

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
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 12, resets_at: "2026-07-18T14:39:00Z" },
          },
        },
      });

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

      const settingsFlagIndex = invocation.args.indexOf("--settings");
      assert.notEqual(settingsFlagIndex, -1);
      const flagSettings = JSON.parse(invocation.args[settingsFlagIndex + 1] ?? "{}") as {
        readonly disableAllHooks?: boolean;
      };
      assert.equal(flagSettings.disableAllHooks, true);
    }).pipe(Effect.scoped),
  );
});

it.effect("preserves initialized capabilities when optional usage times out", () =>
  Effect.gen(function* () {
    const usageStarted = yield* Deferred.make<void>();
    let abortSignal: AbortSignal | undefined;
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
      abortSignal = options?.abortController?.signal;
      return {
        initializationResult: async () => ({
          account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },
          commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],
        }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => {
          Deferred.doneUnsafe(usageStarted, Effect.void);
          return new Promise(() => {});
        },
      } as ReturnType<typeof ClaudeSdk.query>;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const probe = yield* probeClaudeCapabilities(
      decodeClaudeSettings({ binaryPath: "claude" }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(usageStarted);
    yield* TestClock.adjust("4 seconds");
    const capabilities = yield* Fiber.join(probe);
    assert.equal(capabilities?.email, "dev@example.com");
    assert.equal(capabilities?.subscriptionType, "pro");
    assert.equal(capabilities?.tokenSource, "oauth");
    assert.deepEqual(capabilities?.slashCommands, [
      { name: "review", description: "Review changes", input: { hint: "[path]" } },
    ]);
    assert.equal(capabilities?.usage, undefined);
    assert.equal(abortSignal?.aborted, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("asks for usage without the local transcript scan", () =>
  Effect.gen(function* () {
    let usageOptions: unknown;
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(
      () =>
        ({
          initializationResult: async () => ({
            account: { email: "dev@example.com", subscriptionType: "max", tokenSource: "oauth" },
            commands: [],
          }),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (options?: unknown) => {
            usageOptions = options;
            return { rate_limits_available: true, rate_limits: null };
          },
        }) as unknown as ReturnType<typeof ClaudeSdk.query>,
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    yield* probeClaudeCapabilities(decodeClaudeSettings({ binaryPath: "claude" }));
    assert.deepEqual(usageOptions, { skipBehaviors: true });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
