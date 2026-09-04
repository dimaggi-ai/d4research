import { describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RESEARCH_DELEGATION_BUDGET_PER_TURN,
  RESEARCH_STEP_VISIT_LIMIT,
  ThreadId,
  TurnId,
  type ServerProvider,
} from "@d4research/contracts";

import {
  RESEARCH_RETAINED_RUN_LIMIT,
  ResearchDelegationBudget,
  ResearchDelegationBudgetLive,
} from "./budget.ts";
import * as Cause from "effect/Cause";

import {
  type DelegateThreadSnapshot,
  buildResearchSharedMemoContext,
  buildDelegateThreadId,
  DELEGATE_RUNTIME_MODE,
  delegateApprovalDecision,
  extractAssistantText,
  findPipelinePromptFile,
  listPipelinePromptFiles,
  isColdStartProne,
  isTimeoutCause,
  makeResearchDelegateHandler,
  parseDelegateTarget,
  runBoundedDelegation,
  resolveAuthoredPipelineFallbackTargets,
  resolveDelegateTarget,
  settleDelegateThread,
} from "./handlers.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerConfig from "../../../config.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionThreadCheckpointContext,
} from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderAdapterRegistry } from "../../../provider/Services/ProviderAdapterRegistry.ts";
import { makeProviderRegistryLayer } from "../../../provider/testUtils/providerRegistryMock.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { makeConfiguredMemoryConnector } from "../memory/localConnector.ts";

describe("delegate session isolation", () => {
  it("uses unique thread ids even when parallel calls share one clock tick", () => {
    const first = buildDelegateThreadId(1_000, "delegate-a");
    const second = buildDelegateThreadId(1_000, "delegate-b");
    expect(first).not.toBe(second);
  });

  it("keeps adviser sessions permission-gated", () => {
    expect(DELEGATE_RUNTIME_MODE).toBe("approval-required");
  });

  it("declines every unvalidated headless approval request", () => {
    expect(delegateApprovalDecision("file_read_approval")).toBe("decline");
    expect(delegateApprovalDecision("exec_command_approval")).toBe("decline");
    expect(delegateApprovalDecision("file_change_approval")).toBe("decline");
    expect(delegateApprovalDecision("unknown")).toBe("decline");
  });
});

describe("research shared Memo context", () => {
  it("excludes composer attachments by source and text signature", () => {
    const shared = buildResearchSharedMemoContext([
      {
        text: "d4research provider handoff.\nUseful bounded finding.",
        metadata: { source: "t3research-provider-handoff" },
      },
      {
        text: "d4research Memo attachment chunk.\nSensitive source-labeled text.",
        metadata: { source: "d4research-composer-attachment:memoattachment0123456789abcdef" },
      },
      {
        text: "d4research Memo attachment manifest.\nSensitive signature-only text.",
      },
    ]);

    expect(shared).toContain("Useful bounded finding");
    expect(shared).not.toContain("Sensitive");
  });

  it("bounds automatic context with an explicit marker", () => {
    const shared = buildResearchSharedMemoContext([{ text: "x".repeat(1_000) }], 200);
    expect(shared).toHaveLength(200);
    expect(shared).toContain("Shared Memo context truncated at 200 characters");
  });
});

describe("pipeline prompt-file lookup", () => {
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    research: {
      ...DEFAULT_SERVER_SETTINGS.research,
      scenarios: [
        {
          name: "shared",
          pipelinePrompt: "research",
          promptFiles: [
            { name: "rules.md", content: "research rules" },
            { name: "research-only.md", content: "research only" },
          ],
        },
      ],
    },
    dev: {
      scenarios: [
        {
          name: "shared",
          pipelinePrompt: "dev",
          promptFiles: [{ name: "rules.md", content: "dev rules" }],
        },
      ],
      activeScenario: "shared",
    },
  };

  it("keeps same-named research and dev files in separate namespaces", () => {
    expect(
      findPipelinePromptFile(settings, {
        pipelineKind: "research",
        scenario: "shared",
        promptFileName: "rules.md",
      })?.content,
    ).toBe("research rules");
    expect(
      findPipelinePromptFile(settings, {
        pipelineKind: "dev",
        scenario: "shared",
        promptFileName: "rules.md",
      })?.content,
    ).toBe("dev rules");
  });

  it("does not leak a research attachment into a dev delegation", () => {
    expect(
      findPipelinePromptFile(settings, {
        pipelineKind: "dev",
        scenario: "shared",
        promptFileName: "research-only.md",
      }),
    ).toBeNull();
  });

  it("does not fall through to a different scenario's prompt files", () => {
    const withAnotherDevScenario = {
      ...settings,
      dev: {
        ...settings.dev,
        scenarios: [
          ...settings.dev.scenarios,
          {
            name: "other",
            pipelinePrompt: "other",
            promptFiles: [{ name: "other-only.md", content: "must stay scoped" }],
          },
        ],
      },
    };
    expect(
      findPipelinePromptFile(withAnotherDevScenario, {
        pipelineKind: "dev",
        scenario: "shared",
        promptFileName: "other-only.md",
      }),
    ).toBeNull();
    expect(
      findPipelinePromptFile(withAnotherDevScenario, {
        pipelineKind: "dev",
        scenario: "other",
        promptFileName: "other-only.md",
      })?.content,
    ).toBe("must stay scoped");
  });

  it("resolves an unknown scenario to nothing instead of every scenario", () => {
    const withAnotherResearchScenario = {
      ...settings,
      research: {
        ...settings.research,
        scenarios: [
          ...settings.research.scenarios,
          {
            name: "audit",
            pipelinePrompt: "audit",
            promptFiles: [{ name: "audit-only.md", content: "must stay scoped" }],
          },
        ],
      },
    };
    expect(
      findPipelinePromptFile(withAnotherResearchScenario, {
        pipelineKind: "research",
        scenario: "no-such-scenario",
        promptFileName: "audit-only.md",
      }),
    ).toBeNull();
    expect(
      listPipelinePromptFiles(withAnotherResearchScenario, "research", "no-such-scenario"),
    ).toEqual([]);
  });

  it("reads pre-scenario research files only while no scenario is configured", () => {
    const legacy = {
      ...DEFAULT_SERVER_SETTINGS,
      research: {
        ...DEFAULT_SERVER_SETTINGS.research,
        scenarios: [],
        promptFiles: [{ name: "legacy.md", content: "legacy rules" }],
      },
    };
    // Un-migrated: the top-level list *is* the synthetic `default` scenario.
    expect(
      findPipelinePromptFile(legacy, {
        pipelineKind: "research",
        scenario: "default",
        promptFileName: "legacy.md",
      })?.content,
    ).toBe("legacy rules");
    // Migrated: the settings panel copied them into a real scenario, so the
    // stale top-level list must no longer widen every scenario's reach.
    const migrated = {
      ...legacy,
      research: { ...legacy.research, scenarios: settings.research.scenarios },
    };
    expect(
      findPipelinePromptFile(migrated, {
        pipelineKind: "research",
        scenario: "shared",
        promptFileName: "legacy.md",
      }),
    ).toBeNull();
  });
});

describe("research delegate handler", () => {
  it("uses the exact production flow with a gated workspace-scoped adviser session", async () => {
    await Effect.gen(function* () {
      const started = yield* Ref.make<ReadonlyArray<Record<string, unknown>>>([]);
      const sent = yield* Ref.make<ReadonlyArray<string>>([]);
      const stopped = yield* Ref.make<ReadonlyArray<string>>([]);
      const failStart = yield* Ref.make(false);
      const failWarmup = yield* Ref.make(false);
      const failApprovalResponse = yield* Ref.make(false);
      const failUserInputResponse = yield* Ref.make(false);
      const warmupBusyReads = yield* Ref.make(0);
      const activeDelegateThreadId = yield* Ref.make<string | null>(null);
      const approvalDecision = yield* Deferred.make<string>();
      const userInputAnswers = yield* Deferred.make<Record<string, unknown>>();
      const runtimeEvents = yield* PubSub.unbounded<never>();
      const delegateTurns = yield* Ref.make<ReadonlyArray<{ id: TurnId; items: unknown[] }>>([]);
      const instanceId = ProviderInstanceId.make("codex");
      const provider = ProviderDriverKind.make("codex");
      const providerSnapshot = {
        instanceId,
        driver: provider,
        enabled: true,
        installed: true,
        version: "test",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-08-08T00:00:00.000Z",
        models: [
          {
            slug: "gpt-5.6-sol",
            name: "GPT-5.6-Sol",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "glm-5.2:cloud",
            name: "GLM 5.2 Cloud",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider;
      const adapter = {
        provider,
        capabilities: { sessionModelSwitch: "in-session" as const },
        startSession: (input: Record<string, unknown>) =>
          Effect.gen(function* () {
            yield* Ref.update(started, (all) => [...all, input]);
            if (yield* Ref.get(failStart)) return yield* Effect.die("start exploded");
            yield* Ref.set(activeDelegateThreadId, String(input.threadId));
            return {
              provider,
              providerInstanceId: instanceId,
              threadId: input.threadId,
              cwd: input.cwd,
              runtimeMode: input.runtimeMode,
              status: "ready",
              model: "gpt-5.6-sol",
              createdAt: "2026-08-08T00:00:00.000Z",
              updatedAt: "2026-08-08T00:00:00.000Z",
            };
          }),
        sendTurn: (input: { threadId: string; input?: string }) =>
          Effect.gen(function* () {
            if (input.input === "Reply with the single word: OK" && (yield* Ref.get(failWarmup))) {
              return yield* Effect.die("warm-up transport failed");
            }
            if (input.input !== "Reply with the single word: OK") {
              const warmupStillBusy = (yield* Ref.get(warmupBusyReads)) > 0;
              if (warmupStillBusy) return yield* Effect.die("real turn overlapped warm-up");
            }
            yield* Ref.update(sent, (all) => [...all, input.input ?? ""]);
            yield* PubSub.publish(runtimeEvents, {
              type: "request.opened",
              provider,
              threadId: input.threadId,
              requestId: "delegate-read-request",
              payload: { requestType: "file_read_approval", detail: "read the workspace" },
            } as never);
            if (yield* Ref.get(failApprovalResponse)) return yield* Effect.never;
            yield* Deferred.await(approvalDecision);
            yield* PubSub.publish(runtimeEvents, {
              type: "user-input.requested",
              provider,
              threadId: input.threadId,
              requestId: "delegate-question",
              payload: { questions: [] },
            } as never);
            if (yield* Ref.get(failUserInputResponse)) return yield* Effect.never;
            yield* Deferred.await(userInputAnswers);
            const id = TurnId.make(`delegate-turn-${(yield* Ref.get(delegateTurns)).length}`);
            yield* Ref.update(delegateTurns, (turns) => [
              ...turns,
              { id, items: [{ text: "review verdict: PASS" }] },
            ]);
            if (input.input === "Reply with the single word: OK") {
              yield* Ref.set(warmupBusyReads, 2);
            }
            return { threadId: input.threadId, turnId: id };
          }),
        readThread: (threadId: string) =>
          Ref.get(delegateTurns).pipe(Effect.map((turns) => ({ threadId, turns }))),
        listSessions: () =>
          Effect.all([
            Ref.getAndUpdate(warmupBusyReads, (reads) => Math.max(0, reads - 1)),
            Ref.get(activeDelegateThreadId),
          ]).pipe(
            Effect.map(([reads, activeThreadId]) =>
              reads > 0
                ? [
                    {
                      threadId: activeThreadId,
                      status: "running",
                    },
                  ]
                : [],
            ),
          ),
        stopSession: (threadId: string) => Ref.update(stopped, (all) => [...all, String(threadId)]),
        interruptTurn: () => Effect.void,
        respondToRequest: (_threadId: string, _requestId: string, decision: string) =>
          Effect.gen(function* () {
            if (yield* Ref.get(failApprovalResponse)) {
              return yield* Effect.die("approval response transport failed");
            }
            yield* Deferred.succeed(approvalDecision, decision);
          }),
        respondToUserInput: (
          _threadId: string,
          _requestId: string,
          answers: Record<string, unknown>,
        ) =>
          Effect.gen(function* () {
            if (yield* Ref.get(failUserInputResponse)) {
              return yield* Effect.die("user-input response transport failed");
            }
            yield* Deferred.succeed(userInputAnswers, answers);
          }),
        hasSession: () => Effect.succeed(true),
        rollbackThread: (threadId: string) =>
          Ref.get(delegateTurns).pipe(Effect.map((turns) => ({ threadId, turns }))),
        stopAll: () => Effect.void,
        streamEvents: Stream.fromPubSub(runtimeEvents),
      } as never;
      const facadeMustNotRun = () =>
        Effect.die(
          "research delegates must bypass ProviderService's durable user-session lifecycle",
        );
      const providerServiceLayer = Layer.succeed(
        ProviderService,
        ProviderService.of({
          startSession: facadeMustNotRun,
          sendTurn: facadeMustNotRun,
          interruptTurn: facadeMustNotRun,
          respondToRequest: facadeMustNotRun,
          respondToUserInput: facadeMustNotRun,
          stopSession: facadeMustNotRun,
          listSessions: facadeMustNotRun,
          getCapabilities: facadeMustNotRun,
          getInstanceInfo: facadeMustNotRun,
          assertConversationRollbackSupported: facadeMustNotRun,
          rollbackConversation: facadeMustNotRun,
          uploadFeedback: facadeMustNotRun,
          streamEvents: Stream.fromPubSub(runtimeEvents),
          subscribeEvents: PubSub.subscribe(runtimeEvents).pipe(
            Effect.map((subscription) => Stream.fromEffectRepeat(PubSub.take(subscription))),
          ),
        } as ProviderServiceShape),
      );
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        research: { ...DEFAULT_SERVER_SETTINGS.research, shareMemoContext: false },
        dev: {
          scenarios: [
            {
              name: "review",
              pipelinePrompt: "review",
              promptFiles: [{ name: "rules.md", content: "CHECK THE BOUNDARY" }],
            },
          ],
          activeScenario: "review",
        },
      };
      const settingsRef = yield* Ref.make(settings);
      const settingsLayer = Layer.succeed(
        ServerSettingsService,
        ServerSettingsService.of({
          start: Effect.void,
          ready: Effect.void,
          getSettings: Ref.get(settingsRef),
          updateSettings: () => Effect.die("unused"),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.succeed(Stream.empty),
        }),
      );
      const registryLayer = Layer.succeed(
        ProviderAdapterRegistry,
        ProviderAdapterRegistry.of({
          getByInstance: () => Effect.succeed(adapter),
          getInstanceInfo: () => Effect.die("unused"),
          listInstances: () => Effect.succeed([instanceId]),
          listProviders: () => Effect.succeed([provider]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.die("unused"),
        }),
      );
      const orchestratorContext: ProjectionThreadCheckpointContext = {
        threadId: ThreadId.make("orchestrator-thread"),
        projectId: ProjectId.make("project"),
        workspaceRoot: "/workspace/project",
        worktreePath: "/workspace/project/.worktrees/task",
        checkpoints: [],
      };
      const orchestratorContextRef = yield* Ref.make<
        Option.Option<ProjectionThreadCheckpointContext>
      >(Option.some(orchestratorContext));
      const projectionLayer = Layer.mock(ProjectionSnapshotQuery)({
        getThreadCheckpointContext: () => Ref.get(orchestratorContextRef),
        getProjectShellById: (projectId) =>
          Effect.succeed(
            Option.some({
              id: projectId,
              title: "Project A",
              workspaceRoot: "/workspace/project",
              defaultModelSelection: null,
              scripts: [],
              createdAt: "2026-08-08T00:00:00.000Z",
              updatedAt: "2026-08-08T00:00:00.000Z",
            }),
          ),
      });
      const invocation = {
        environmentId: EnvironmentId.make("environment"),
        threadId: ThreadId.make("orchestrator-thread"),
        providerSessionId: "provider-session",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        capabilities: new Set(["research"] as const),
        issuedAt: 0,
      };
      const fileSystem = yield* FileSystem.FileSystem;
      const configBaseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "delegate-handler-test-",
      });
      const configLayer = ServerConfig.layerTest(process.cwd(), configBaseDir).pipe(
        Layer.provide(NodeServices.layer),
      );
      const layer = Layer.mergeAll(
        settingsLayer,
        registryLayer,
        makeProviderRegistryLayer([providerSnapshot]),
        providerServiceLayer,
        projectionLayer,
        ResearchDelegationBudgetLive,
        NodeServices.layer,
        FetchHttpClient.layer,
        configLayer,
      );

      const unauthorized = yield* makeResearchDelegateHandler({ pollDelay: Effect.void })({
        target: "codex:gpt-5.6-sol",
        prompt: "This must be rejected before any delegate work starts.",
        pipelineKind: "dev",
        scenario: "review",
        step: "authorization-check",
        visit: 1,
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation,
          capabilities: new Set<McpInvocationContext.McpCapability>(),
        }),
        Effect.provide(layer),
        Effect.map(() => ({ _tag: "Right" as const })),
        Effect.catch((left) => Effect.succeed({ _tag: "Left" as const, left })),
      );
      expect(unauthorized).toMatchObject({
        _tag: "Left",
        left: { failureKind: "authorization" },
      });
      expect(yield* Ref.get(started)).toEqual([]);

      // A prompt file with no scenario must fail closed. Searching every
      // scenario instead would inline attachments this run has no claim to.
      const unscoped = yield* makeResearchDelegateHandler({ pollDelay: Effect.void })({
        target: "codex:gpt-5.6-sol",
        prompt: "Review the change.",
        promptFileName: "rules.md",
        pipelineKind: "dev",
        step: "scope-check",
        visit: 1,
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provide(layer),
        Effect.map(() => ({ _tag: "Right" as const })),
        Effect.catch((left) => Effect.succeed({ _tag: "Left" as const, left })),
      );
      expect(unscoped).toMatchObject({
        _tag: "Left",
        left: { detail: expect.stringContaining("needs the scenario it is attached to") },
      });
      expect(yield* Ref.get(started)).toEqual([]);
      expect(yield* Ref.get(sent)).toEqual([]);

      const result = yield* makeResearchDelegateHandler({ pollDelay: Effect.void })({
        target: "codex:gpt-5.6-sol",
        prompt: "Review the change.",
        promptFileName: "rules.md",
        pipelineKind: "dev",
        scenario: "review",
        step: "3",
        visit: 1,
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provide(layer),
      );

      expect(result).toMatchObject({
        target: "codex:gpt-5.6-sol",
        step: "3",
        visit: 1,
        text: "review verdict: PASS",
        truncated: false,
        remainingBudget: RESEARCH_DELEGATION_BUDGET_PER_TURN - 1,
      });
      expect(yield* Ref.get(started)).toEqual([
        expect.objectContaining({
          runtimeMode: "approval-required",
          cwd: "/workspace/project/.worktrees/task",
          modelSelection: { instanceId, model: "gpt-5.6-sol" },
        }),
      ]);
      expect(yield* Ref.get(sent)).toEqual([
        "--- PROMPT FILE: rules.md ---\nCHECK THE BOUNDARY\n\nReview the change.",
      ]);
      expect(yield* Ref.get(stopped)).toHaveLength(1);
      expect(yield* Deferred.await(approvalDecision)).toBe("decline");
      expect(yield* Deferred.await(userInputAnswers)).toEqual({});

      const cloudResult = yield* makeResearchDelegateHandler({ pollDelay: Effect.void })({
        target: "codex:glm-5.2:cloud",
        prompt: "Review after the cold start.",
        pipelineKind: "dev",
        scenario: "review",
        step: "3b",
        visit: 1,
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provide(layer),
      );
      expect(cloudResult.text).toBe("review verdict: PASS");
      expect((yield* Ref.get(sent)).slice(-2)).toEqual([
        "Reply with the single word: OK",
        "Review after the cold start.",
      ]);
      expect(yield* Ref.get(warmupBusyReads)).toBe(0);
      expect(yield* Ref.get(stopped)).toHaveLength(2);

      // A warm-up failure must not be swallowed. Sending the real prompt into
      // the same possibly-running session could overlap turns and return the
      // warm-up answer as the pipeline result; fail so the caller can fallback.
      yield* Ref.set(failWarmup, true);
      const sentBeforeFailedWarmup = (yield* Ref.get(sent)).length;
      const failedWarmup = yield* Effect.exit(
        makeResearchDelegateHandler({ pollDelay: Effect.void })({
          target: "codex:glm-5.2:cloud",
          prompt: "must never be sent after a failed warm-up",
          pipelineKind: "dev",
          scenario: "review",
          step: "3c",
          visit: 1,
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provide(layer),
        ),
      );
      expect(failedWarmup._tag).toBe("Failure");
      expect((yield* Ref.get(sent)).slice(sentBeforeFailedWarmup)).toEqual([]);
      expect(yield* Ref.get(stopped)).toHaveLength(3);
      yield* Ref.set(failWarmup, false);

      // Cleanup wraps the whole delegate lifecycle, not merely the final turn.
      // A failed start must still stop the synthetic session and unsubscribe
      // its hot approval stream instead of leaking a headless delegate.
      yield* Ref.set(failStart, true);
      const failedStart = yield* Effect.exit(
        makeResearchDelegateHandler({ pollDelay: Effect.void })({
          target: "codex:gpt-5.6-sol",
          prompt: "This turn must not start.",
          pipelineKind: "dev",
          scenario: "review",
          step: "4",
          visit: 1,
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provide(layer),
        ),
      );
      expect(failedStart._tag).toBe("Failure");
      expect(yield* Ref.get(stopped)).toHaveLength(4);

      yield* Ref.set(failStart, false);
      yield* Ref.set(settingsRef, {
        ...settings,
        research: { ...settings.research, shareMemoContext: true },
      });
      const memory = yield* makeConfiguredMemoryConnector().pipe(Effect.provide(layer));
      yield* memory.add("scopeboundary project A context", "test", "Project A");
      yield* memory.add("scopeboundary project B private context", "test", "Project B");
      const scopedMemoryResult = yield* makeResearchDelegateHandler({ pollDelay: Effect.void })({
        target: "codex:gpt-5.6-sol",
        prompt: "scopeboundary",
        pipelineKind: "dev",
        scenario: "review",
        step: "memory-scope",
        visit: 1,
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provide(layer),
      );
      expect(scopedMemoryResult.text).toBe("review verdict: PASS");
      const scopedTurnInput = (yield* Ref.get(sent)).at(-1) ?? "";
      expect(scopedTurnInput).toContain("scopeboundary project A context");
      expect(scopedTurnInput).not.toContain("scopeboundary project B private context");
      expect(yield* Ref.get(stopped)).toHaveLength(5);

      // A missing authoritative thread→project relation must disable context
      // injection, not silently widen the same search across every project.
      yield* Ref.set(orchestratorContextRef, Option.none());
      const unscopedFallbackResult = yield* makeResearchDelegateHandler({
        pollDelay: Effect.void,
      })({
        target: "codex:gpt-5.6-sol",
        prompt: "scopeboundary",
        pipelineKind: "dev",
        scenario: "review",
        step: "missing-memory-scope",
        visit: 1,
      }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provide(layer),
      );
      expect(unscopedFallbackResult.text).toBe("review verdict: PASS");
      expect((yield* Ref.get(sent)).at(-1)).toBe("scopeboundary");
      expect(yield* Ref.get(stopped)).toHaveLength(6);
      yield* Ref.set(orchestratorContextRef, Option.some(orchestratorContext));

      yield* Ref.set(settingsRef, settings);
      yield* Ref.set(failApprovalResponse, true);
      const failedApproval = yield* Effect.exit(
        makeResearchDelegateHandler({ pollDelay: Effect.void })({
          target: "codex:gpt-5.6-sol",
          prompt: "trigger an approval",
          pipelineKind: "dev",
          scenario: "review",
          step: "approval-failure",
          visit: 1,
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provide(layer),
          Effect.timeout(2_000),
        ),
      );
      expect(failedApproval._tag).toBe("Failure");
      if (failedApproval._tag === "Failure") {
        const failure = Cause.findErrorOption(failedApproval.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toMatchObject({
            _tag: "ResearchDelegateError",
            detail: expect.stringContaining("Failed to answer an approval request"),
          });
        }
      }
      expect(yield* Ref.get(stopped)).toHaveLength(7);

      yield* Ref.set(failApprovalResponse, false);
      yield* Ref.set(failUserInputResponse, true);
      const failedUserInput = yield* Effect.exit(
        makeResearchDelegateHandler({ pollDelay: Effect.void })({
          target: "codex:gpt-5.6-sol",
          prompt: "trigger a user-input request",
          pipelineKind: "dev",
          scenario: "review",
          step: "user-input-failure",
          visit: 1,
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provide(layer),
          Effect.timeout(2_000),
        ),
      );
      expect(failedUserInput._tag).toBe("Failure");
      if (failedUserInput._tag === "Failure") {
        const failure = Cause.findErrorOption(failedUserInput.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toMatchObject({
            _tag: "ResearchDelegateError",
            detail: expect.stringContaining("Failed to answer a user-input request"),
          });
        }
      }
      expect(yield* Ref.get(stopped)).toHaveLength(8);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);
  });
});

/**
 * One adapter + layer for the inline-delegation contract tests. Built once per
 * test so the budget Ref is shared exactly as the server runtime shares it
 * between the MCP toolkit and the orchestration reactor.
 */
const makeInlineDelegationHarness = Effect.fnUntraced(function* () {
  const instanceId = ProviderInstanceId.make("codex");
  const provider = ProviderDriverKind.make("codex");
  const providerSnapshot = {
    instanceId,
    driver: provider,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-08T00:00:00.000Z",
    models: [{ slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  } satisfies ServerProvider;
  const runtimeEvents = yield* PubSub.unbounded<never>();
  const fileSystem = yield* FileSystem.FileSystem;
  const configBaseDir = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "inline-delegation-test-",
  });
  const turns = yield* Ref.make<ReadonlyArray<{ items: ReadonlyArray<unknown> }>>([]);
  const sentAttachments = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const adapter = {
    provider,
    startSession: () => Effect.void,
    sendTurn: (sendInput: { readonly attachments?: ReadonlyArray<unknown> }) =>
      Ref.set(sentAttachments, sendInput.attachments ?? []).pipe(
        Effect.andThen(
          Ref.update(turns, (all) => [...all, { items: [{ text: "delegate answer" }] }]),
        ),
      ),
    readThread: (threadId: string) =>
      Ref.get(turns).pipe(Effect.map((all) => ({ threadId, turns: all }))),
    listSessions: () => Effect.succeed([]),
    stopSession: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
  } as never;
  const layer = Layer.mergeAll(
    Layer.succeed(
      ServerSettingsService,
      ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          research: { ...DEFAULT_SERVER_SETTINGS.research, shareMemoContext: false },
        }),
        updateSettings: () => Effect.die("unused"),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      }),
    ),
    Layer.succeed(
      ProviderAdapterRegistry,
      ProviderAdapterRegistry.of({
        getByInstance: () => Effect.succeed(adapter),
        getInstanceInfo: () => Effect.die("unused"),
        listInstances: () => Effect.succeed([instanceId]),
        listProviders: () => Effect.succeed([provider]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.die("unused"),
      }),
    ),
    makeProviderRegistryLayer([providerSnapshot]),
    Layer.succeed(
      ProviderService,
      ProviderService.of({
        streamEvents: Stream.fromPubSub(runtimeEvents),
        subscribeEvents: Effect.succeed(Stream.never),
      } as unknown as ProviderServiceShape),
    ),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadCheckpointContext: () =>
        Effect.succeed(Option.none<ProjectionThreadCheckpointContext>()),
    }),
    ResearchDelegationBudgetLive,
    NodeServices.layer,
    FetchHttpClient.layer,
    ServerConfig.layerTest(process.cwd(), configBaseDir).pipe(Layer.provide(NodeServices.layer)),
  );
  const invocation = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("orchestrator-thread"),
    providerSessionId: "provider-session",
    providerInstanceId: instanceId,
    turnId: TurnId.make("turn-1"),
    capabilities: new Set(["research"] as const),
    issuedAt: 0,
  };
  return { layer, invocation, sentAttachments };
});

describe("inline delegation shares the pipeline delegation budget", () => {
  it("draws both entry points from one per-run ceiling and one accounting map", async () => {
    await Effect.gen(function* () {
      const harness = yield* makeInlineDelegationHarness();
      // One `Effect.provide` builds the budget Ref once, exactly as the server
      // runtime does for the MCP toolkit and the orchestration reactor.
      const charged = yield* Effect.gen(function* () {
        const pipelineCall = yield* makeResearchDelegateHandler({ pollDelay: Effect.void })({
          target: "codex:gpt-5.6-sol",
          prompt: "pipeline step",
          step: "2",
          visit: 1,
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, harness.invocation),
        );
        const inlineCall = yield* runBoundedDelegation({
          orchestratorThreadId: ThreadId.make("orchestrator-thread"),
          runId: "orchestrator-thread:turn-1",
          requestedTarget: "codex:gpt-5.6-sol",
          resolvedTarget: "codex:gpt-5.6-sol",
          substituted: false,
          parsedTarget: { instanceId: "codex", model: "gpt-5.6-sol" },
          prompt: "inline question",
          attachments: [],
          resolvePromptFile: Effect.succeed(null),
          shareMemoContext: false,
          step: "inline",
          visit: 1,
          pollDelay: Effect.void,
        });
        return { pipelineCall, inlineCall };
      }).pipe(Effect.provide(harness.layer));

      expect(charged.pipelineCall.remainingBudget).toBe(RESEARCH_DELEGATION_BUDGET_PER_TURN - 1);
      // The inline turn is charged against the same run, not a fresh ceiling.
      expect(charged.inlineCall.remainingBudget).toBe(RESEARCH_DELEGATION_BUDGET_PER_TURN - 2);
      expect(charged.inlineCall.text).toBe("delegate answer");
      expect(charged.inlineCall.step).toBe("inline");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);
  });

  it("delivers a turn's attachments to the delegate instead of dropping them", async () => {
    await Effect.gen(function* () {
      const harness = yield* makeInlineDelegationHarness();
      const attachment = {
        type: "image" as const,
        id: "attachment-1",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 128,
      };
      yield* runBoundedDelegation({
        orchestratorThreadId: ThreadId.make("orchestrator-thread"),
        runId: "orchestrator-thread:turn-attachments",
        requestedTarget: "codex:gpt-5.6-sol",
        resolvedTarget: "codex:gpt-5.6-sol",
        substituted: false,
        parsedTarget: { instanceId: "codex", model: "gpt-5.6-sol" },
        prompt: "what is in this screenshot?",
        attachments: [attachment],
        resolvePromptFile: Effect.succeed(null),
        shareMemoContext: false,
        step: "inline",
        visit: 1,
        pollDelay: Effect.void,
      }).pipe(Effect.provide(harness.layer));

      expect(yield* Ref.get(harness.sentAttachments)).toEqual([attachment]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);
  });

  it("still burns budget when the model names a prompt file that does not exist", async () => {
    await Effect.gen(function* () {
      const harness = yield* makeInlineDelegationHarness();
      // "Every research_delegate call burns budget" is the loop guard: a model
      // retrying an invalid argument must run out of budget, not retry free.
      const charged = yield* Effect.gen(function* () {
        const rejected = yield* Effect.exit(
          makeResearchDelegateHandler({ pollDelay: Effect.void })({
            target: "codex:gpt-5.6-sol",
            prompt: "pipeline step",
            promptFileName: "does-not-exist.md",
            scenario: "missing-scenario",
            step: "2",
            visit: 1,
          }).pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, harness.invocation),
          ),
        );
        const accepted = yield* makeResearchDelegateHandler({ pollDelay: Effect.void })({
          target: "codex:gpt-5.6-sol",
          prompt: "pipeline step",
          step: "3",
          visit: 1,
        }).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, harness.invocation),
        );
        return { rejected, accepted };
      }).pipe(Effect.provide(harness.layer));

      expect(charged.rejected._tag).toBe("Failure");
      // Two calls, two charges — the rejected one included.
      expect(charged.accepted.remainingBudget).toBe(RESEARCH_DELEGATION_BUDGET_PER_TURN - 2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);
  });
});

const withBudget = <A>(
  body: (budget: ResearchDelegationBudget["Service"]) => Effect.Effect<A>,
): Promise<A> =>
  Effect.gen(function* () {
    const budget = yield* ResearchDelegationBudget;
    return yield* body(budget);
  }).pipe(Effect.provide(ResearchDelegationBudgetLive), Effect.runPromise);

describe("parseDelegateTarget", () => {
  it("splits on the first colon only, keeping colon-bearing models whole", () => {
    expect(parseDelegateTarget("claudeAgent:glm-5.2:cloud")).toEqual({
      instanceId: "claudeAgent",
      model: "glm-5.2:cloud",
    });
  });

  it("rejects malformed targets", () => {
    expect(parseDelegateTarget("claudeAgent")).toBeNull();
    expect(parseDelegateTarget(":model")).toBeNull();
    expect(parseDelegateTarget("claudeAgent:")).toBeNull();
  });
});

const readyDelegateProvider = (input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly model: string;
}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(input.instanceId),
  driver: ProviderDriverKind.make(input.driver),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-08T00:00:00.000Z",
  models: [
    {
      slug: input.model,
      name: input.model,
      isCustom: false,
      capabilities: null,
    },
  ],
  slashCommands: [],
  skills: [],
});

describe("resolveDelegateTarget", () => {
  const providers = [
    readyDelegateProvider({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      model: "claude-fable-5",
    }),
    readyDelegateProvider({
      instanceId: "codex",
      driver: "codex",
      model: "gpt-5.6-sol",
    }),
  ];

  it("uses the exact requested model when it is ready", () => {
    expect(
      resolveDelegateTarget({
        target: "claudeAgent:claude-fable-5",
        fallbackTargets: ["codex:gpt-5.6-sol"],
        policy: "labeled-fallback",
        providers,
      }),
    ).toMatchObject({
      ok: true,
      requestedTarget: "claudeAgent:claude-fable-5",
      resolvedTarget: "claudeAgent:claude-fable-5",
      substituted: false,
    });
  });

  it("uses only an explicitly listed fallback and labels the actual model", () => {
    expect(
      resolveDelegateTarget({
        target: "claudeAgent:claude-opus-5",
        fallbackTargets: ["codex:gpt-5.6-sol"],
        policy: "labeled-fallback",
        providers,
      }),
    ).toMatchObject({
      ok: true,
      requestedTarget: "claudeAgent:claude-opus-5",
      resolvedTarget: "codex:gpt-5.6-sol",
      substituted: true,
    });
  });

  it("never invents an equivalent model or bypasses Exact policy", () => {
    const noAuthoredFallback = resolveDelegateTarget({
      target: "claudeAgent:claude-opus-5",
      policy: "labeled-fallback",
      providers,
    });
    const exact = resolveDelegateTarget({
      target: "claudeAgent:claude-opus-5",
      fallbackTargets: ["codex:gpt-5.6-sol"],
      policy: "exact",
      providers,
    });

    expect(noAuthoredFallback).toMatchObject({ ok: false });
    expect(noAuthoredFallback.ok ? "" : noAuthoredFallback.detail).toContain(
      "No explicit fallback targets",
    );
    expect(exact).toMatchObject({ ok: false });
    expect(exact.ok ? "" : exact.detail).toContain("Exact");
  });
});

describe("resolveAuthoredPipelineFallbackTargets", () => {
  const providers = [
    readyDelegateProvider({ instanceId: "codex", driver: "codex", model: "gpt-5.6-sol" }),
  ];

  it("authorizes only directives on explicitly labeled FALLBACK lines", () => {
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      research: {
        ...DEFAULT_SERVER_SETTINGS.research,
        scenarios: [
          {
            name: "review",
            pipelinePrompt: "PRIMARY: !codex:missing-model\nFALLBACK directive: !codex:gpt-5.6-sol",
            promptFiles: [],
          },
        ],
        activeScenario: "review",
      },
    };

    expect(
      resolveAuthoredPipelineFallbackTargets({
        pipelineKind: "research",
        scenario: "review",
        settings,
        providers,
      }),
    ).toEqual(["codex:gpt-5.6-sol"]);
    expect(
      resolveAuthoredPipelineFallbackTargets({
        pipelineKind: "research",
        scenario: undefined,
        settings,
        providers,
      }),
    ).toEqual([]);
  });
});

describe("extractAssistantText", () => {
  it("returns the codex agentMessage, not the echoed prompt or reasoning", () => {
    // Shape codex app-server thread/read returns: the echoed prompt and
    // intermediate reasoning share the turn with the real answer.
    const thread = {
      turns: [
        {
          items: [
            { type: "userMessage", content: [{ type: "text", text: "Reply with OK" }] },
            { type: "reasoning", content: ["thinking about it"] },
            { type: "agentMessage", text: "OK" },
          ],
        },
      ],
    };
    expect(extractAssistantText(thread)).toBe("OK");
  });

  it("is empty for an in-progress codex turn that has no agentMessage yet", () => {
    // The window the poll must not exit on: turn exists, answer does not.
    const thread = { turns: [{ items: [{ type: "userMessage", content: [] }] }] };
    expect(extractAssistantText(thread)).toBe("");
  });

  it("reads claude/opencode role+content blocks and skips the user turn", () => {
    const thread = {
      turns: [
        {
          items: [
            { role: "user", content: [{ type: "text", text: "question" }] },
            { role: "assistant", content: [{ type: "text", text: "answer" }] },
          ],
        },
      ],
    };
    expect(extractAssistantText(thread)).toBe("answer");
  });

  it("reads the ACP assistant snapshot while ignoring its prompt/result record", () => {
    const thread = {
      turns: [
        {
          items: [
            {
              prompt: [{ type: "text", text: "Return exactly ACP_OK" }],
              result: { stopReason: "end_turn" },
            },
            { id: "assistant:1", type: "agentMessage", text: "ACP_OK" },
          ],
        },
      ],
    };
    expect(extractAssistantText(thread)).toBe("ACP_OK");
    expect(extractAssistantText({ turns: [{ items: [thread.turns[0]!.items[0]!] }] })).toBe("");
  });

  it("reads agy plain-string and { text } items", () => {
    expect(extractAssistantText({ turns: [{ items: ["hello ", { text: "world" }] }] })).toBe(
      "hello world",
    );
  });

  it("is empty when there are no turns", () => {
    expect(extractAssistantText({ turns: [] })).toBe("");
  });
});

describe("isColdStartProne", () => {
  it("flags Ollama cloud models so they get a warm-up turn", () => {
    expect(isColdStartProne("kimi-k2.7-code:cloud")).toBe(true);
    expect(isColdStartProne("glm-5.2:cloud")).toBe(true);
  });

  it("leaves warm hosted/local models on the fast path", () => {
    expect(isColdStartProne("claude-fable-5")).toBe(false);
    expect(isColdStartProne("gpt-5.6-terra")).toBe(false);
    expect(isColdStartProne("gemini-3.6-flash-high")).toBe(false);
  });
});

describe("ResearchDelegationBudget", () => {
  it("atomically caps a burst of parallel delegations", async () => {
    const charges = await withBudget((budget) =>
      Effect.all(
        Array.from({ length: RESEARCH_DELEGATION_BUDGET_PER_TURN * 4 }, (_, index) =>
          budget.charge({
            runId: "parallel-run",
            step: `step-${index}`,
            target: `provider:model-${index}`,
          }),
        ),
        { concurrency: "unbounded" },
      ),
    );
    expect(charges.filter((charge) => charge.ok)).toHaveLength(RESEARCH_DELEGATION_BUDGET_PER_TURN);
    expect(charges.filter((charge) => !charge.ok)).toHaveLength(
      RESEARCH_DELEGATION_BUDGET_PER_TURN * 3,
    );
  });

  it("cuts a step→target loop at the visit limit while other steps continue", () =>
    withBudget((budget) =>
      Effect.gen(function* () {
        const base = { runId: "run-1", target: "codex:gpt-5.6-terra" };
        for (let visit = 0; visit < RESEARCH_STEP_VISIT_LIMIT; visit++) {
          const charge = yield* budget.charge({ ...base, step: "3" });
          expect(charge.ok).toBe(true);
        }
        const cut = yield* budget.charge({ ...base, step: "3" });
        expect(cut.ok).toBe(false);
        expect(cut.reason).toContain('Step "3"');
        // Same target from a different step is a different loop.
        const otherStep = yield* budget.charge({ ...base, step: "4" });
        expect(otherStep.ok).toBe(true);
      }),
    ));

  it("exhausts the per-run total and reports zero remaining", () =>
    withBudget((budget) =>
      Effect.gen(function* () {
        for (let call = 0; call < RESEARCH_DELEGATION_BUDGET_PER_TURN; call++) {
          const charge = yield* budget.charge({
            runId: "run-2",
            step: `step-${call}`,
            target: `provider:model-${call}`,
          });
          expect(charge.ok).toBe(true);
        }
        const spent = yield* budget.charge({
          runId: "run-2",
          step: "extra",
          target: "provider:model-extra",
        });
        expect(spent.ok).toBe(false);
        expect(spent.remaining).toBe(0);
        expect(spent.reason).toContain("budget exhausted");
      }),
    ));

  it("tracks turns independently even when they belong to one durable thread", () =>
    withBudget((budget) =>
      Effect.gen(function* () {
        const drain = { step: "1", target: "a:b" };
        for (let call = 0; call < RESEARCH_STEP_VISIT_LIMIT; call++) {
          yield* budget.charge({ runId: "thread-3:turn-a", ...drain });
        }
        const cutFirstTurn = yield* budget.charge({ runId: "thread-3:turn-a", ...drain });
        expect(cutFirstTurn.ok).toBe(false);
        // A new turn in the same thread is a new pipeline run immediately;
        // no one-hour idle timer may carry exhaustion across user requests.
        const nextTurn = yield* budget.charge({ runId: "thread-3:turn-b", ...drain });
        expect(nextTurn.ok).toBe(true);
      }),
    ));

  it("never evicts an active run when the retained-run bound is reached", () =>
    withBudget((budget) =>
      Effect.gen(function* () {
        const first = yield* budget.charge({
          runId: "oldest-run",
          step: "1",
          target: "a:b",
        });
        expect(first.remaining).toBe(RESEARCH_DELEGATION_BUDGET_PER_TURN - 1);

        for (let index = 1; index < RESEARCH_RETAINED_RUN_LIMIT; index += 1) {
          const charge = yield* budget.charge({
            runId: `run-${index}`,
            step: "1",
            target: "a:b",
          });
          expect(charge.ok).toBe(true);
        }

        const overflow = yield* budget.charge({
          runId: "overflow-run",
          step: "1",
          target: "a:b",
        });
        expect(overflow.ok).toBe(false);
        expect(overflow.reason).toContain("capacity");

        // Capacity pressure must not reset the oldest possibly-active run.
        const continued = yield* budget.charge({
          runId: "oldest-run",
          step: "1",
          target: "a:b",
        });
        expect(continued.ok).toBe(true);
        expect(continued.remaining).toBe(RESEARCH_DELEGATION_BUDGET_PER_TURN - 2);
      }),
    ));
});

describe("isTimeoutCause", () => {
  // The RUN STATE report needs to distinguish a blown deadline from a crash;
  // both arrive through the same catchCause.
  it("recognizes Effect timeout failures", () => {
    const timeoutLike = { _tag: "TimeoutError" };
    expect(isTimeoutCause(Cause.fail(timeoutLike))).toBe(true);
  });

  it("recognizes prose timeout messages from adapters", () => {
    expect(isTimeoutCause(Cause.fail(new Error("Agy turn timed out after 6 minutes")))).toBe(true);
  });

  it("does not classify ordinary crashes as timeouts", () => {
    expect(isTimeoutCause(Cause.fail(new Error("spawn E2BIG")))).toBe(false);
    expect(isTimeoutCause(Cause.die(new Error("boom")))).toBe(false);
  });
});

// A scripted stand-in for a provider adapter's readThread. Each entry is the
// snapshot a poll would observe at that moment. Content is deliberately
// generic ("preamble", "answer") — no prompts, files, or article text.
const snap = (text: string): DelegateThreadSnapshot =>
  text === "" ? { turns: [] } : { turns: [{ items: [{ text }] }] };

const scriptedReader = (script: ReadonlyArray<DelegateThreadSnapshot>) =>
  Effect.gen(function* () {
    const index = yield* Ref.make(0);
    const readThread = Effect.gen(function* () {
      const i = yield* Ref.getAndUpdate(index, (n) => Math.min(n + 1, script.length - 1));
      return script[i]!;
    });
    return yield* Effect.succeed(readThread);
  });

const runSettle = (
  script: ReadonlyArray<DelegateThreadSnapshot>,
  opts?: { turnsBefore?: number; stableReads?: number; maxAttempts?: number },
): Promise<string> =>
  Effect.gen(function* () {
    const readThread = yield* scriptedReader(script);
    const thread = yield* settleDelegateThread({
      readThread,
      turnsBefore: opts?.turnsBefore ?? 0,
      maxAttempts: opts?.maxAttempts ?? 50,
      stableReads: opts?.stableReads ?? 3,
      pollDelay: Effect.void, // no real waiting in tests
    });
    return extractAssistantText(thread);
  }).pipe(Effect.runPromise);

describe("settleDelegateThread", () => {
  it("returns a one-shot answer once it has been stable", async () => {
    const answer = "the complete answer";
    expect(await runSettle([snap(answer), snap(answer), snap(answer), snap(answer)])).toBe(answer);
  });

  it("waits past a streaming preamble for the grown, settled answer", async () => {
    // Reasoning models stream an intent line first, then the real answer.
    const script = [
      snap("I'll verify the claims"),
      snap("I'll verify the claims. Result:"),
      snap("I'll verify the claims. Result: full answer body"),
      snap("I'll verify the claims. Result: full answer body"),
      snap("I'll verify the claims. Result: full answer body"),
      snap("I'll verify the claims. Result: full answer body"),
    ];
    expect(await runSettle(script)).toContain("full answer body");
  });

  it("does not settle on a preamble while text is still growing", async () => {
    // If it settled early this would return the short preamble, not the answer.
    const script = [
      snap("prefix"),
      snap("prefix growing"),
      snap("prefix growing more"),
      snap("prefix growing more done"),
      snap("prefix growing more done"),
      snap("prefix growing more done"),
      snap("prefix growing more done"),
    ];
    expect(await runSettle(script)).toBe("prefix growing more done");
  });

  it("returns empty when the delegate never produces text", async () => {
    // The handler turns an empty result into a typed 'empty' failure.
    expect(await runSettle([snap(""), snap(""), snap("")], { maxAttempts: 5 })).toBe("");
  });

  it("ignores an in-progress turn with no assistant text yet", async () => {
    // turnsBefore=1 and a lone empty turn: not a new answer.
    expect(
      await runSettle([{ turns: [{ items: [] }] }, { turns: [{ items: [] }] }], {
        turnsBefore: 1,
        maxAttempts: 4,
      }),
    ).toBe("");
  });

  it("documents the silent-gap limitation: a preamble stable across the window settles", async () => {
    // A provider that emits a preamble then goes output-silent (e.g. a long
    // tool call) longer than stableReads polls will settle on the preamble.
    // This is the known gap that needs a provider completion signal.
    const preamble = "I'll search the web";
    expect(
      await runSettle([snap(preamble), snap(preamble), snap(preamble), snap(preamble)], {
        stableReads: 2,
      }),
    ).toBe(preamble);
  });
});

describe("settleDelegateThread with a busy signal", () => {
  // The live failure shape: the delegate posts a short intent line, the text
  // goes perfectly stable while the provider works silently for minutes, and
  // the real answer only lands when the session leaves "running".
  it("waits out a stable preamble while the session is busy", async () => {
    const preamble = "I'm validating the claims against primary sources";
    const answer = preamble + " Result table: | claim | url |";
    const script = [
      snap(preamble),
      snap(preamble),
      snap(preamble),
      snap(preamble),
      snap(preamble),
      snap(answer),
      snap(answer),
      snap(answer),
      snap(answer),
      snap(answer),
    ];
    const busyScript = [true, true, true, true, true, false, false, false, false, false];
    const text = await Effect.gen(function* () {
      const readThread = yield* scriptedReader(script);
      const busyIndex = yield* Ref.make(0);
      const isBusy = Ref.getAndUpdate(busyIndex, (n) =>
        Math.min(n + 1, busyScript.length - 1),
      ).pipe(Effect.map((i) => busyScript[i]!));
      const thread = yield* settleDelegateThread({
        readThread,
        turnsBefore: 0,
        maxAttempts: 50,
        stableReads: 2,
        pollDelay: Effect.void,
        isBusy,
      });
      return extractAssistantText(thread);
    }).pipe(Effect.runPromise);
    expect(text).toContain("Result table");
  });

  it("accepts a settled answer after a successful idle probe", async () => {
    const answer = "final answer body";
    const text = await Effect.gen(function* () {
      const readThread = yield* scriptedReader([
        snap(answer),
        snap(answer),
        snap(answer),
        snap(answer),
      ]);
      const thread = yield* settleDelegateThread({
        readThread,
        turnsBefore: 0,
        maxAttempts: 20,
        stableReads: 2,
        pollDelay: Effect.void,
        isBusy: Effect.succeed(false),
      });
      return extractAssistantText(thread);
    }).pipe(Effect.runPromise);
    expect(text).toBe(answer);
  });

  it("fails closed when provider status cannot prove the turn is idle", async () => {
    const exit = await Effect.gen(function* () {
      const readThread = yield* scriptedReader([snap("stable preamble")]);
      return yield* Effect.exit(
        settleDelegateThread({
          readThread,
          turnsBefore: 0,
          maxAttempts: 20,
          stableReads: 2,
          pollDelay: Effect.void,
          isBusy: Effect.die("status unavailable"),
        }),
      );
    }).pipe(Effect.runPromise);
    expect(exit._tag).toBe("Failure");
  });

  it("still bounds a session that never stops reporting busy", async () => {
    const text = await Effect.gen(function* () {
      const readThread = yield* scriptedReader([snap("stuck preamble")]);
      const thread = yield* settleDelegateThread({
        readThread,
        turnsBefore: 0,
        maxAttempts: 10,
        stableReads: 2,
        pollDelay: Effect.void,
        isBusy: Effect.succeed(true),
      });
      return extractAssistantText(thread);
    }).pipe(Effect.runPromise);
    // maxAttempts spent → returns what exists; the handler's outer timeout and
    // empty/preamble rules take it from there.
    expect(text).toBe("stuck preamble");
  });
});
