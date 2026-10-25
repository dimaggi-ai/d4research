import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ContextHandoffId,
  DEFAULT_D4_AGENT_SETTINGS,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type AgentMonitorUpdate,
  type OrchestrationV2ProviderThread,
} from "@d4research/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@d4research/provider-core/server/ProviderAdapter";
import * as Config from "../config.ts";
import * as Agent from "../d4Agent/D4Agent.ts";
import * as AgentAccess from "../d4Agent/D4AgentAccess.ts";
import * as AgentContext from "../d4Agent/D4AgentContext.ts";
import * as AgentStore from "../d4Agent/D4AgentStore.ts";
import * as SystemProbe from "../d4Agent/SystemProbe.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as SecondBrain from "../second-brain/SecondBrainService.ts";
import * as Settings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as AgentMonitor from "./AgentMonitorReactor.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const selection = { instanceId, model: "isolated-model" };
const ybProject = ProjectId.make("YB-project");
const dimaggiProject = ProjectId.make("Dimaggi-project");
const ybDigestThread = ThreadId.make("YB-prior-digest");
const dimaggiDigestThread = ThreadId.make("Dimaggi-current-digest");

const monitorUpdate = (threadId: ThreadId): AgentMonitorUpdate => ({
  threadId,
  revision: 1,
  report: {
    schemaVersion: 1,
    runId: null,
    attemptId: null,
    classification: "idle",
    reason: "no_active_run",
    attentionRequired: false,
    notificationEligible: false,
    reportKey: `report:${threadId}`,
    observedAt: "2026-10-24T00:00:00.000Z",
    runStatus: null,
    pendingRequestId: null,
  },
});

const makeRecordingAdapter = (
  opened: Array<ProviderAdapter.ProviderAdapterV2OpenSessionInput>,
  started: Array<ProviderAdapter.ProviderAdapterV2TurnInput>,
  resumed: Array<OrchestrationV2ProviderThread>,
): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (input) =>
    Effect.gen(function* () {
      opened.push(input);
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const now = yield* DateTime.now;
      return {
        instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: input.runtimePolicy.cwd ?? "/unused-fallback",
          model: input.modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.fromQueue(events),
        ensureThread: (thread) =>
          Effect.succeed({
            id: ProviderThreadId.make(`provider:${thread.threadId}`),
            driver,
            providerInstanceId: instanceId,
            providerSessionId: input.providerSessionId,
            appThreadId: thread.threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver,
              nativeId: `native:${thread.threadId}`,
              strength: "strong",
            },
            nativeConversationHeadRef:
              started.length === 0
                ? { driver, nativeId: "YB-prior-resume-cursor", strength: "strong" }
                : null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          }),
        resumeThread: ({ providerThread }) =>
          Effect.sync(() => {
            resumed.push(providerThread);
            return providerThread;
          }),
        startTurn: (turn) =>
          Effect.gen(function* () {
            started.push(turn);
            const completedAt = yield* DateTime.now;
            const providerTurnId = ProviderTurnId.make(`turn:${turn.attemptId}`);
            yield* Queue.offer(events, {
              type: "message.updated",
              driver,
              message: {
                id: MessageId.make(`assistant:${turn.runId}`),
                threadId: turn.threadId,
                runId: turn.runId,
                nodeId: turn.rootNodeId,
                role: "assistant",
                createdBy: "agent",
                creationSource: "provider",
                text: started.length === 1 ? "YB-prior-assistant-transcript" : "Current answer",
                attachments: [],
                streaming: false,
                createdAt: completedAt,
                updatedAt: completedAt,
              },
            });
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: providerTurnId,
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: { driver, nativeId: `native:${providerTurnId}`, strength: "strong" },
                ordinal: turn.providerTurnOrdinal,
                status: "completed",
                startedAt: completedAt,
                completedAt,
              },
            });
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThread.id,
              providerTurnId,
              runOrdinal: turn.runOrdinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
          }),
        steerTurn: () => Effect.die("Unexpected steering across an isolated session"),
        interruptTurn: () => Effect.void,
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: () => Effect.die("Unexpected native history read"),
        rollbackThread: () => Effect.die("Unexpected rollback"),
        forkThread: () => Effect.die("Unexpected native fork"),
      };
    }),
});

it.effect.each([
  {
    operation: "switch-context",
    name: "switch-context runs two real d4 turns in one database without carrying prior context into provider input",
  },
  {
    operation: "new-session",
    name: "new-session runs two real d4 turns in one database without carrying prior context into provider input",
  },
  {
    operation: "cto-answer",
    name: "persisted CTO answer starts no run, reaches the next provider turn, and stays out of a fresh same-context session",
  },
  {
    operation: "repeated-close",
    name: "repeated new sessions retire distinct provider identities and release resources before replacements",
  },
  {
    operation: "size-scope-change",
    name: "size rotation drops an old summary when context membership changes",
  },
  {
    operation: "size-rotation",
    name: "size budget rotates through an old-session summary and seeds only the same context",
  },
  {
    operation: "pipeline-remap",
    name: "pipeline remapping retires the affected session without carrying old provider input",
  },
  {
    operation: "rapid-switch",
    name: "rapid Global YB Dimaggi YB Personal Global switching resumes provider sessions without cross-context input",
  },
] as const)(
  "$name",
  ({ operation }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-session-isolation-" });
        const opened: Array<ProviderAdapter.ProviderAdapterV2OpenSessionInput> = [];
        const started: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
        const resumed: Array<OrchestrationV2ProviderThread> = [];
        const updates = yield* Ref.make([
          monitorUpdate(ybDigestThread),
          monitorUpdate(dimaggiDigestThread),
        ]);
        const buildTurnContext = vi.fn(() => Effect.die("Legacy memory must not enter d4 turns"));
        const settings = Settings.layerTest({
          d4Agent: {
            ...DEFAULT_D4_AGENT_SETTINGS,
            enabled: true,
            modelSelection: selection,
            projectContexts: { [ybProject]: "YB", [dimaggiProject]: "Dimaggi" },
          },
          secondBrain: { path: "/synthetic-memory", injection: { enabled: true } },
          handoff: { memoryBackend: "meko", contextCompression: { mode: "smart" } },
        }).pipe(Layer.orDie);
        const database = Sqlite.layerMemory;
        const config = Config.layerTest(directory, directory);
        const common = Layer.mergeAll(
          settings,
          database,
          config,
          ProviderRegistryMock.layer([
            {
              instanceId,
              driver,
              enabled: true,
              installed: true,
              version: "1",
              status: "ready",
              auth: { status: "authenticated" },
              checkedAt: "2026-10-24T00:00:00Z",
              models: [
                { slug: selection.model, name: "Isolated", isCustom: false, capabilities: null },
              ],
              skills: [],
              slashCommands: [],
            },
          ]),
          Layer.mock(AgentMonitor.AgentMonitorReactor)({ snapshot: Ref.get(updates) }),
          Layer.mock(SystemProbe.SystemProbe)({ check: () => Effect.succeed([]) }),
        ).pipe(Layer.provideMerge(NodeServices.layer));
        const store = AgentStore.layer.pipe(Layer.provide(common));
        const context = AgentContext.layer.pipe(Layer.provide(Layer.merge(common, store)));
        const projects = RuntimeLayer.layerProjectService.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provide(
            Layer.mock(ProjectEnrichment.ProjectEnrichmentService)({
              invalidate: () => Effect.void,
              getAvailable: () =>
                Effect.succeed({
                  repositoryIdentity: null,
                  faviconPath: null,
                  repositoryIdentityResolved: true,
                }),
            }),
          ),
          Layer.provide(common),
          Layer.orDie,
        );
        const runtime = ProviderReplayHarness.layerWithRegistry(
          { name: `d4-${operation}` },
          ProviderAdapterRegistry.layerSingle(makeRecordingAdapter(opened, started, resumed)),
          {
            layerDatabase: database,
            layerServerSettings: settings,
            layerProjectService: projects,
            layerSecondBrain: Layer.mock(SecondBrain.SecondBrainService)({ buildTurnContext }),
          },
        ).pipe(Layer.provide(Layer.mergeAll(context, store, common)));
        const threads = ThreadManagement.layer.pipe(
          Layer.provide(runtime),
          Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
          Layer.provide(settings),
        );
        const agent = Agent.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              threads,
              runtime,
              projects,
              store,
              ProjectionStore.layer.pipe(Layer.provide(database)),
              common,
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const service = yield* Agent.D4Agent;
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sink = yield* EventSink.EventSinkV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const state = yield* AgentStore.D4AgentStore;
          for (const [threadId, projectId] of [
            [ybDigestThread, ybProject],
            [dimaggiDigestThread, dimaggiProject],
          ] as const) {
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`create:${threadId}`),
              threadId,
              projectId,
              title: threadId,
              modelSelection: selection,
              runtimeMode: "approval-required",
              interactionMode: "default",
              branch: null,
              worktreePath: directory,
              createdBy: "user",
              creationSource: "web",
            });
          }
          const runTurn = Effect.fnUntraced(function* (threadId: ThreadId, text: string) {
            const completed = yield* sink
              .stream({ threadId, afterSequence: yield* sink.latestSequence({ threadId }) })
              .pipe(
                Stream.filter(
                  (stored) =>
                    stored.event.type === "run.updated" &&
                    ["completed", "failed"].includes(stored.event.payload.status),
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.forkScoped,
              );
            yield* service
              .sendMessage({ text })
              .pipe(Effect.provideService(AgentAccess.DispatchOrigin, "authenticated-user"));
            yield* Fiber.join(completed);
            yield* worker.drain();
            const projection = yield* orchestrator.getThreadProjection(threadId);
            expect(projection.runs.at(-1)?.status, JSON.stringify(projection.turnItems)).toBe(
              "completed",
            );
            return projection;
          });
          if (operation === "repeated-close") {
            let session = yield* service.ensureThread();
            for (let count = 0; count < 3; count++) {
              yield* runTurn(session.threadId, `Synthetic close request ${count}`);
              const previous = session;
              session = yield* service.newSession();
              const retired = yield* orchestrator.getThreadProjection(previous.threadId);
              expect(retired.thread.archivedAt).not.toBeNull();
              expect(retired.providerSessions.every((entry) => entry.status === "stopped")).toBe(
                true,
              );
              expect((yield* state.get).retiringThreadId).toBeNull();
            }
            expect(new Set(opened.map((entry) => entry.providerSessionId)).size).toBe(3);
            return;
          }
          if (operation === "size-rotation" || operation === "size-scope-change") {
            const first = yield* service.switchContext({ context: "YB" });
            yield* runTurn(first.threadId, "YB session facts");
            const dimaggi = yield* service.switchContext({ context: "Dimaggi" });
            yield* runTurn(dimaggi.threadId, "Dimaggi_PRIVATE_SUMMARY_EXCLUSION");
            yield* service.switchContext({ context: "YB" });
            yield* state.update((value) => ({
              ...value,
              sessions: value.sessions!.map((session) =>
                session.context === "YB"
                  ? { ...session, inputTokens: 700, contextWindow: 1000 }
                  : session,
              ),
            }));
            yield* runTurn(first.threadId, "Continue the YB work");
            expect(started.at(-1)!.message.text).toContain("Summarize this session");
            expect(started.at(-1)!.providerThread.providerSessionId).toBe(
              started[0]!.providerThread.providerSessionId,
            );
            if (operation === "size-scope-change") {
              const settingsService = yield* Settings.ServerSettingsService;
              const config = yield* settingsService.getSettings;
              yield* settingsService.updateSettings({
                d4Agent: {
                  ...config.d4Agent,
                  projectContexts: {
                    ...config.d4Agent.projectContexts,
                    [ProjectId.make("new-membership")]: "YB",
                  },
                },
              });
            }
            yield* service.tick;
            const fresh = (yield* state.get).threadId!;
            expect(
              fresh,
              JSON.stringify({
                rotation: (yield* state.get).rotation,
                runs: (yield* orchestrator.getThreadProjection(first.threadId)).runs.map(
                  ({ id, status, userMessageId }) => ({ id, status, userMessageId }),
                ),
                messages: (yield* orchestrator.getThreadProjection(first.threadId)).messages.map(
                  ({ id, runId, role, text }) => ({ id, runId, role, text }),
                ),
              }),
            ).not.toBe(first.threadId);
            yield* sink.stream({ threadId: fresh, afterSequence: 0 }).pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "run.updated" &&
                  ["completed", "failed"].includes(stored.event.payload.status),
              ),
              Stream.take(1),
              Stream.runDrain,
            );
            yield* worker.drain();
            const last = started.at(-1)!;
            if (operation === "size-scope-change") {
              expect(last.message.text).not.toContain("Same-context session summary");
              expect(last.message.text).not.toContain("Current answer");
            } else {
              expect(last.message.text).toContain("Same-context session summary");
              expect(last.message.text).toContain("Current answer");
            }
            expect(last.message.text).toContain("Continue the YB work");
            expect(JSON.stringify(last)).not.toContain("Dimaggi_PRIVATE_SUMMARY_EXCLUSION");
            expect(last.providerThread.providerSessionId).not.toBe(
              started[0]!.providerThread.providerSessionId,
            );
            expect((yield* state.get).sessions!.length).toBe(2);
            return;
          }
          if (operation === "pipeline-remap") {
            const settingsService = yield* Settings.ServerSettingsService;
            const initialConfig = yield* settingsService.getSettings;
            yield* settingsService.updateSettings({
              d4Agent: {
                ...initialConfig.d4Agent,
                pipelineProjects: { "research:shared": ybProject },
              },
            });
            const previous = yield* service.switchContext({ context: "YB" });
            yield* runTurn(previous.threadId, "YB_PRIVATE_PIPELINE_BEFORE_REMAP");
            const withPipeline = yield* settingsService.getSettings;
            yield* settingsService.updateSettings({
              d4Agent: {
                ...withPipeline.d4Agent,
                pipelineProjects: {
                  ...withPipeline.d4Agent.pipelineProjects,
                  "dev:unrelated": dimaggiProject,
                },
              },
            });
            expect((yield* service.ensureThread()).threadId).toBe(previous.threadId);
            const unrelatedConfig = yield* settingsService.getSettings;
            yield* settingsService.updateSettings({
              d4Agent: {
                ...unrelatedConfig.d4Agent,
                pipelineProjects: {
                  ...unrelatedConfig.d4Agent.pipelineProjects,
                  "research:shared": dimaggiProject,
                },
              },
            });
            const fresh = yield* service.ensureThread();
            expect(fresh.threadId).not.toBe(previous.threadId);
            yield* runTurn(fresh.threadId, "Continue current scope");
            expect(started).toHaveLength(2);
            expect(started[1]!.providerThread.providerSessionId).not.toBe(
              started[0]!.providerThread.providerSessionId,
            );
            expect(JSON.stringify(started[1])).not.toContain("YB_PRIVATE_PIPELINE_BEFORE_REMAP");
            expect(started[1]!.message.text).not.toContain("Same-context session summary");
            return;
          }
          if (operation === "rapid-switch") {
            const identities = new Map<string, ThreadId>();
            const providerIds = new Map<string, string>();
            for (let round = 0; round < 3; round++)
              for (const context of [
                "Global",
                "YB",
                "Dimaggi",
                "YB",
                "Personal",
                "Global",
              ] as const) {
                const current = yield* service.switchContext({ context });
                if (identities.has(context)) expect(current.threadId).toBe(identities.get(context));
                identities.set(context, current.threadId);
                yield* Ref.set(updates, [
                  monitorUpdate(ybDigestThread),
                  monitorUpdate(dimaggiDigestThread),
                  ...[...identities.values()].map(monitorUpdate),
                ]);
                yield* runTurn(current.threadId, `${context}_PRIVATE_MATERIAL_${round}`);
                const turn = started.at(-1)!;
                if (providerIds.has(context))
                  expect(turn.providerThread.providerSessionId).toBe(providerIds.get(context));
                expect(turn.providerThread.providerSessionId).not.toBeNull();
                providerIds.set(context, turn.providerThread.providerSessionId!);
                expect((yield* state.get).sessions!.length).toBeLessThanOrEqual(4);
                for (const agentThreadId of identities.values())
                  expect(turn.message.text).not.toContain(agentThreadId);
                expect(turn.message.text).toContain(`${context}_PRIVATE_MATERIAL_${round}`);
                for (const other of ["Global", "YB", "Dimaggi", "Personal"] as const) {
                  if (other !== context)
                    expect(JSON.stringify(turn)).not.toContain(`${other}_PRIVATE_MATERIAL`);
                }
              }
            expect(providerIds.size).toBe(4);
            expect(new Set(providerIds.values()).size).toBe(4);
            expect(opened).toHaveLength(4);
            expect(started).toHaveLength(18);
            for (const turn of started) {
              const context = [...identities].find(([, id]) => id === turn.threadId)?.[0];
              expect(context).toBeDefined();
              for (const other of ["Global", "YB", "Dimaggi", "Personal"] as const)
                if (other !== context)
                  expect(JSON.stringify(turn)).not.toContain(`${other}_PRIVATE_MATERIAL`);
              expect(turn.providerThread.providerSessionId).toBe(providerIds.get(context!));
            }
            for (const resumedThread of resumed) {
              const context = [...identities].find(
                ([, id]) => id === resumedThread.appThreadId,
              )?.[0];
              expect(context).toBeDefined();
              expect(resumedThread.providerSessionId).toBe(providerIds.get(context!));
            }
            return;
          }
          if (operation === "cto-answer") {
            const firstSession = yield* service.switchContext({ context: "Dimaggi" });
            const firstProjection = yield* runTurn(firstSession.threadId, "Check CTO status");
            expect(started).toHaveLength(1);
            const answerPrefix =
              "Synthetic CTO answer: only the current Dimaggi session may read this.";
            const answerSuffix = "FULL_CTO_ANSWER_SUFFIX_REMAINS_IN_CHAT";
            const answer = `${answerPrefix}\n${"Synthetic detail. ".repeat(400)}\n${answerSuffix}`;
            const messageId = MessageId.make("d4-cto:synthetic-answer");
            const threads = yield* ThreadManagement.ThreadManagementService;
            const command = {
              type: "thread.system-message.record" as const,
              commandId: CommandId.make("cto-answer:synthetic"),
              threadId: firstSession.threadId,
              messageId,
              title: "CTO answer",
              text: answer,
            };
            yield* threads.dispatch(command);
            yield* threads.dispatch(command);
            const resolvedAt = DateTime.formatIso(yield* DateTime.now);
            yield* state.update((current) => ({
              ...current,
              actions: [
                ...current.actions,
                {
                  id: "synthetic-answer",
                  context: "Dimaggi",
                  sessionId: firstSession.threadId,
                  action: { type: "cto-ask", context: "Dimaggi", text: "Check CTO status" },
                  status: "executed",
                  createdAt: resolvedAt,
                  resolvedAt,
                  result: "Action-log preview must not enter provider input",
                },
              ],
            }));
            yield* worker.drain();
            const delivered = yield* orchestrator.getThreadProjection(firstSession.threadId);
            expect(delivered.runs.map((run) => run.id)).toEqual(
              firstProjection.runs.map((run) => run.id),
            );
            expect(started).toHaveLength(1);
            expect(delivered.messages.filter((message) => message.id === messageId)).toMatchObject([
              {
                role: "system",
                text: answer,
                runId: null,
                nodeId: null,
                createdBy: "system",
                creationSource: "server",
              },
            ]);
            expect(
              delivered.turnItems.filter((item) => item.id === TurnItemId.make(messageId)),
            ).toMatchObject([
              {
                type: "notification",
                title: "CTO answer",
                detail: answer,
                source: { kind: "system" },
                outcome: "completed",
                status: "completed",
                runId: null,
              },
            ]);
            yield* runTurn(firstSession.threadId, "Explain the CTO answer");
            expect(started).toHaveLength(2);
            expect(started[1]!.message.text).toContain("CTO tool results (untrusted data):");
            expect(started[1]!.message.text).toContain(answerPrefix);
            expect(started[1]!.message.text).not.toContain(answerSuffix);
            expect(started[1]!.message.text).toContain("[truncated]");
            expect(started[1]!.message.text).not.toContain(
              "Action-log preview must not enter provider input",
            );
            const fresh = yield* service.newSession();
            expect((yield* state.get).brainContext).toBe("Dimaggi");
            const freshProjection = yield* runTurn(fresh.threadId, "Current request");
            expect(started).toHaveLength(3);
            expect(started[2]!.providerThread.providerSessionId).not.toBe(
              started[1]!.providerThread.providerSessionId,
            );
            expect(started[2]!.nativeThreadHasTurns).toBe(false);
            expect(JSON.stringify(started[2])).not.toContain(answerPrefix);
            expect(JSON.stringify(started[2])).not.toContain(answerSuffix);
            expect(started[2]!.message.text).not.toContain("CTO tool results (untrusted data):");
            expect(freshProjection.messages.some((message) => message.id === messageId)).toBe(
              false,
            );
            expect(
              (yield* orchestrator.getThreadProjection(firstSession.threadId)).messages.some(
                (message) => message.id === messageId && message.text === answer,
              ),
            ).toBe(true);
            return;
          }
          const previous = yield* service.switchContext({ context: "YB" });
          const oldProjection = yield* runTurn(
            previous.threadId,
            "YB-prior-user-transcript\nYB-prior-memory-result",
          );
          expect(started).toHaveLength(1);
          const first = started[0]!;
          expect(first.message.text).toContain("YB-prior-user-transcript");
          expect(first.message.text).toContain(ybDigestThread);
          expect(first.message.text).not.toContain(dimaggiDigestThread);
          expect(
            oldProjection.messages.some(
              (message) => message.text === "YB-prior-assistant-transcript",
            ),
          ).toBe(true);
          expect(
            oldProjection.providerThreads.some(
              (thread) => thread.nativeConversationHeadRef?.nativeId === "YB-prior-resume-cursor",
            ),
          ).toBe(true);
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make("event:YB-prior-summary"),
                threadId: previous.threadId,
                occurredAt: now,
                type: "context-handoff.updated",
                payload: {
                  id: ContextHandoffId.make("YB-prior-handoff"),
                  threadId: previous.threadId,
                  targetRunId: first.runId,
                  fromProviderThreadIds: [first.providerThread.id],
                  toProviderThreadId: first.providerThread.id,
                  coveredRunOrdinals: { from: 1, to: 1 },
                  strategy: "full_thread_summary",
                  status: "ready",
                  summaryMessageId: null,
                  summaryText: "YB-prior-summary",
                  createdByProviderInstanceId: instanceId,
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ],
          });
          expect(
            (yield* orchestrator.getThreadProjection(previous.threadId)).contextHandoffs[0]
              ?.summaryText,
          ).toBe("YB-prior-summary");
          yield* Ref.set(updates, [monitorUpdate(dimaggiDigestThread)]);
          const fresh =
            operation === "switch-context"
              ? yield* service.switchContext({ context: "Dimaggi" })
              : yield* service.newSession();
          expect(fresh.threadId).not.toBe(previous.threadId);
          expect(fresh.projectId).toBe(previous.projectId);
          const previousArchived = (yield* orchestrator.getThreadProjection(previous.threadId))
            .thread.archivedAt;
          if (operation === "switch-context") expect(previousArchived).toBeNull();
          else expect(previousArchived).not.toBeNull();
          const currentProjection = yield* runTurn(fresh.threadId, "Current request");
          expect(started).toHaveLength(2);
          const second = started[1]!;
          expect(second.threadId).toBe(fresh.threadId);
          expect(second.message.text).toContain(
            `Bound context: ${operation === "switch-context" ? "Dimaggi" : "YB"}`,
          );
          expect(second.message.text).toContain("User message:\nCurrent request");
          expect(second.providerThread.providerSessionId).not.toBe(
            first.providerThread.providerSessionId,
          );
          expect(second.providerThread.nativeThreadRef?.nativeId).not.toBe(
            first.providerThread.nativeThreadRef?.nativeId,
          );
          expect(second.nativeThreadHasTurns).toBe(false);
          expect(second.runtimePolicy).toMatchObject({
            toolPolicy: "d4-agent",
            approvalPolicy: "never",
          });
          const serialized = JSON.stringify({ opened: opened[1], input: second });
          for (const marker of [
            "YB-prior-user-transcript",
            "YB-prior-assistant-transcript",
            "YB-prior-memory-result",
            "YB-prior-summary",
            "YB-prior-resume-cursor",
            ybDigestThread,
            first.providerThread.nativeThreadRef!.nativeId,
            first.providerThread.providerSessionId!,
          ]) {
            expect(serialized).not.toContain(marker);
          }
          expect(opened).toHaveLength(2);
          for (const open of opened) {
            expect(open.resumeFromSession).toBeUndefined();
            expect(open.initialNativeThreadId).toBeUndefined();
          }
          expect(resumed).toEqual([]);
          expect(currentProjection.contextHandoffs).toEqual([]);
          expect(
            currentProjection.messages
              .filter((message) => message.role === "user")
              .map((message) => message.text),
          ).toEqual(["Current request"]);
          expect(buildTurnContext).not.toHaveBeenCalled();
          expect((yield* state.get).bindings).toContainEqual({
            sessionId: second.providerThread.providerSessionId,
            threadId: fresh.threadId,
            context: operation === "switch-context" ? "Dimaggi" : "YB",
          });
        }).pipe(Effect.provide(Layer.mergeAll(agent, runtime, store, threads, settings)));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  { timeout: 20000 },
);
