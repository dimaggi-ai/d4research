import {
  isCompactionCommandMessage,
  parseGoalCommand,
  type OrchestrationV2ContextHandoff,
} from "@d4research/contracts";
import { describeTaskScopeRefusal, makeTaskScopeEvaluator } from "../d4Agent/D4AgentTaskScope.ts";
import * as D4AgentContext from "../d4Agent/D4AgentContext.ts";
import { selectAppProviderHistory } from "./appProviderHistory.ts";
import { extractTrailingProviderHandoffContext } from "@d4research/shared/providerHandoffPrompt";
import * as HandoffMemory from "../handoffMemory.ts";
import { FetchHttpClient } from "effect/http";
import * as SecondBrainService from "../second-brain/SecondBrainService.ts";
import { modelSelectionsEqual } from "@d4research/shared/model";
import {
  deriveDevProviderCandidates,
  parseDevTrigger,
  providerDriverSupportsPipelineOrchestration,
} from "@d4research/shared/devPipeline";
import {
  buildResearchRunManifest,
  deriveResearchProviderCandidatesFromProviders,
  parseResearchTrigger,
} from "@d4research/shared/researchPipeline";
import { ServerSettingsService } from "../serverSettings.ts";
import { compressHandoffContextLocal } from "../handoffCompression.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { InlineDelegationRunner } from "../mcp/toolkits/research/inlineDelegation.ts";
import { buildResumeNote } from "../mcp/toolkits/research/runArtifacts.ts";
import { OrchestrationEventStore } from "../persistence/OrchestrationEventStore.ts";
import { expandProviderDevMessage, expandProviderResearchMessage } from "./PipelineMessage.ts";
import { tryRunInlineResearchTurn } from "./InlineResearchTurn.ts";
import { withPersistedSkillsContext } from "./ConfiguredSkills.ts";
import { extractTrailingEnabledSkillsContext } from "@d4research/shared/enabledSkillsContext";
import * as McpProviderSessions from "@d4research/provider-core/server/McpProviderSessions";
import { setActiveMcpTurn } from "../mcp/McpSessionRegistry.ts";
import { projectComposerContextForProvider } from "@d4research/shared/composerContextReferences";
import {
  CommandId,
  latestProviderTurnForAttempt,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnId,
} from "@d4research/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import * as EventSink from "./EventSink.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import { isActiveRun } from "./CommandPolicy.ts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  handoffBudget,
  attachmentTokenAllowance,
  contextUsageForHandoff,
  historicalMessage,
  restoreHandoffHistory,
  latestNativeContextUsage,
} from "@d4research/provider-core/server/handoffBudget";
import { makeHandoffCompactionRecovery } from "./HandoffCompactionRecovery.ts";
import { deliverContextHandoffs, withInlineContext } from "./ContextHandoffDelivery.ts";
import * as ProviderAdapter from "@d4research/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@d4research/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { makeProviderFailure } from "@d4research/provider-core/server/failure";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import {
  isRestartNoteContinuation,
  pendingRestartCancelledBackgroundWork,
  restartCancelledBackgroundWorkNote,
} from "./RestartBackgroundNote.ts";

export class ProviderTurnStartError extends Schema.TaggedError<ProviderTurnStartError>()(
  "ProviderTurnStartError",
  {
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

class WorktreeRecreateError extends Schema.TaggedError<WorktreeRecreateError>()(
  "WorktreeRecreateError",
  {
    worktreePath: Schema.String,
    branch: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not recreate the worktree for branch '${this.branch}' at ${this.worktreePath}.`;
  }
}

class WorktreeRecreateNoBaseError extends Schema.TaggedError<WorktreeRecreateNoBaseError>()(
  "WorktreeRecreateNoBaseError",
  { worktreePath: Schema.String, branch: Schema.String },
) {
  override get message(): string {
    return `Could not recreate branch '${this.branch}' at ${this.worktreePath}: the project workspace has no commit to start it from.`;
  }
}

const isProviderAdapterOpenSessionError = Schema.is(
  ProviderAdapter.ProviderAdapterOpenSessionError,
);
const isProviderTurnStartError = Schema.is(ProviderTurnStartError);

/** These failures happen before Claude reads the prompt, so retry can reuse its session. */
const PROMPT_REFUSAL_TAGS = [
  "ClaudeBackgroundWorkBlocksQueryReplacementError",
  "ClaudeAppendSystemPromptFileError",
  "ClaudeAppendSystemPromptMissingValueError",
  "ClaudeSettingsLaunchArgError",
  "ClaudeMcpRegistrationTimeoutError",
] as const;

const refusedBeforePrompt = (error: unknown): boolean =>
  PROMPT_REFUSAL_TAGS.some((tag) => Predicate.isTagged(error, tag)) ||
  (Predicate.hasProperty(error, "cause") && refusedBeforePrompt(error.cause));

export interface ProviderTurnStartServiceV2Shape {
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly willRetry?: boolean;
  }) => Effect.Effect<void, ProviderTurnStartError>;
}

export class ProviderTurnStartServiceV2 extends Context.Service<
  ProviderTurnStartServiceV2,
  ProviderTurnStartServiceV2Shape
>()("d4research/orchestration-v2/ProviderTurnStartService/ProviderTurnStartServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnStartServiceV2,
  never,
  | SecondBrainService.SecondBrainService
  | EventSink.EventSinkV2
  | ContextHandoffService.ContextHandoffServiceV2
  | IdAllocator.IdAllocatorV2
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | GitWorkflowService.GitWorkflowService
  | ProjectService.ProjectService
  | ProviderAuthService.ProviderAuthService
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunExecutionService.RunExecutionServiceV2
  | RuntimePolicy.RuntimePolicyV2
  | ServerSettingsService
  | ProviderRegistry
  | McpProviderSessions.McpProviderSessions
  | InlineDelegationRunner
  | OrchestrationEventStore
> = Layer.effect(
  ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const handoffMemory = yield* HandoffMemory.HandoffMemory;
    const eventSink = yield* EventSink.EventSinkV2;
    const contextHandoffService = yield* ContextHandoffService.ContextHandoffServiceV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const brain = yield* SecondBrainService.SecondBrainService;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const projects = yield* ProjectService.ProjectService;
    const providerAuth = yield* ProviderAuthService.ProviderAuthService;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const mcpProviderSessions = yield* McpProviderSessions.McpProviderSessions;
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
    const providerRegistry = yield* ProviderRegistry;
    const d4AgentContext = yield* Effect.serviceOption(D4AgentContext.D4AgentContext);
    const currentTaskScopeStatus = yield* makeTaskScopeEvaluator;
    const researchServices = yield* Effect.context<
      InlineDelegationRunner | OrchestrationEventStore
    >();
    const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

    const resolveRecreateBase = Effect.fn("ProviderTurnStartService.resolveRecreateBase")(
      function* (cwd: string) {
        // Recovery can follow an external checkout, before the status cache expires.
        yield* gitWorkflow.invalidateLocalStatus(cwd);
        const { refName: currentBranch } = yield* gitWorkflow.localStatus({ cwd });
        if (currentBranch !== null) {
          const refName = `refs/heads/${currentBranch}`;
          return { refName, baseRefName: refName };
        }
        if (yield* gitWorkflow.hasCommit({ cwd, refName: "refs/remotes/origin/HEAD" })) {
          const { commitSha } = yield* gitWorkflow.resolveRemoteTrackingCommit({
            cwd,
            refName: "HEAD",
            fallbackRemoteName: "origin",
          });
          // Start from the commit so the thread branch does not track the default branch.
          return { refName: commitSha, baseRefName: "refs/remotes/origin/HEAD" };
        }
        if (yield* gitWorkflow.hasCommit({ cwd, refName: "HEAD" })) {
          return { refName: "HEAD", baseRefName: undefined };
        }
        return null;
      },
    );

    const recreateMissingWorktree = Effect.fn("ProviderTurnStartService.recreateMissingWorktree")(
      function* (input: {
        readonly cwd: string;
        readonly worktreePath: string;
        readonly branch: string;
      }) {
        const { cwd, worktreePath, branch } = input;
        yield* gitWorkflow.pruneWorktrees({ cwd });
        const localBranchNames = yield* gitWorkflow.listLocalBranchNames(cwd);
        if (localBranchNames.includes(branch)) {
          yield* gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath });
          return;
        }
        // Push keeps the tracking ref current, so recovery reads it without fetching.
        const pushedRef = `refs/remotes/origin/${branch}`;
        if (yield* gitWorkflow.hasCommit({ cwd, refName: pushedRef })) {
          yield* gitWorkflow.createWorktree({
            cwd,
            refName: pushedRef,
            newRefName: branch,
            path: worktreePath,
          });
          return;
        }
        const base = yield* resolveRecreateBase(cwd);
        if (base === null) {
          return yield* new WorktreeRecreateNoBaseError({ worktreePath, branch });
        }
        yield* gitWorkflow.createWorktree({
          cwd,
          refName: base.refName,
          newRefName: branch,
          ...(base.baseRefName === undefined ? {} : { baseRefName: base.baseRefName }),
          path: worktreePath,
        });
      },
    );

    // Build draining callbacks outside startup scope so they cannot retain full thread history.
    const makeRunControls = (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly attemptId: OrchestrationV2RunAttempt["id"];
      readonly providerThreadId: OrchestrationV2ProviderThread["id"];
      readonly runOrdinal: number;
      readonly inheritedBackgroundTurnItems: ReturnType<
        typeof RunExecutionService.selectInheritedBackgroundTurnItems
      >;
    }) => {
      const isCurrentAttemptInStatus = (expectedStatus: OrchestrationV2Run["status"]) =>
        projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
          Effect.map((current) => {
            const run = current.runs.find((candidate) => candidate.id === input.runId);
            return run?.activeAttemptId === input.attemptId && run.status === expectedStatus;
          }),
        );
      return {
        isCurrentAttemptInStatus,
        loadInheritedBackgroundTurnItems: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) =>
              RunExecutionService.selectInheritedBackgroundTurnItems({
                threadId: input.threadId,
                currentProviderThreadId: input.providerThreadId,
                currentRunOrdinal: input.runOrdinal,
                runs: current.runs,
                turnItems: current.turnItems,
              }),
            ),
            Effect.catchCause(() => Effect.succeed(input.inheritedBackgroundTurnItems)),
          ),
        shouldStartProviderTurn: () => isCurrentAttemptInStatus("running"),
        shouldFinalizeRun: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) => {
              const run = current.runs.find((candidate) => candidate.id === input.runId);
              return (
                run?.activeAttemptId === input.attemptId &&
                (run.status === "starting" || run.status === "running")
              );
            }),
          ),
        hasUnpairedRunInterruptRequest: () =>
          projectionStore
            .hasUnpairedRunInterruptRequest(
              input.threadId,
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-request",
              }),
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-result",
              }),
            )
            .pipe(Effect.catchCause(() => Effect.succeed(false))),
      };
    };

    const makeDeliverySession = (
      session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      startWithHandoffs: (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact?: boolean,
      ) => ReturnType<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>,
    ) => {
      let deliver: typeof startWithHandoffs | undefined = startWithHandoffs;
      const start = (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact = false,
      ) =>
        Effect.suspend(() => {
          if (deliver !== undefined) return deliver(input, compact);
          return compact && session.compactThread !== undefined
            ? session.compactThread(input)
            : session.startTurn(input);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              deliver = undefined;
            }),
          ),
        );
      return {
        ...session,
        startTurn: (input: Parameters<typeof session.startTurn>[0]) => start(input),
        ...(session.compactThread === undefined
          ? {}
          : {
              compactThread: (input: Parameters<typeof session.startTurn>[0]) => start(input, true),
            }),
      };
    };

    const start = Effect.fn("orchestrationV2.providerTurnStart.start")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly willRetry?: boolean;
    }) {
      const { runId } = input;
      const projection = yield* projectionStore.getTurnStartContext(input.threadId, runId);
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        return yield* new ProviderTurnStartError({ runId, cause: `Run ${runId} was not found.` });
      }
      if (run.status !== "starting") {
        return;
      }
      const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      );
      const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
      const checkpointScope = projection.checkpointScopes.find(
        (candidate) => candidate.id === rootNode?.checkpointScopeId,
      );
      // Older versions also stored subagent replies as history handoffs. Their
      // queued completion messages carry the results without a history budget.
      const subagentResultTransfers = new Set(
        projection.contextTransfers
          .filter((transfer) => transfer.type === "subagent_result")
          .map((transfer) => transfer.id),
      );
      const isPendingForRun = (handoff: OrchestrationV2ContextHandoff, anyProviderThread = false) =>
        handoff.status === "ready" &&
        (handoff.targetRunId === run.id ||
          ((anyProviderThread || handoff.toProviderThreadId === run.providerThreadId) &&
            projection.runs.some(
              (source) =>
                source.id === handoff.targetRunId &&
                (source.status === "failed" ||
                  source.status === "interrupted" ||
                  source.status === "cancelled" ||
                  (source.status === "completed" &&
                    handoff.delivery === undefined &&
                    // Compaction and /goal turns defer history to the next turn.
                    projection.messages.some(
                      (message) =>
                        message.id === source.userMessageId &&
                        (isCompactionCommandMessage(message) || parseGoalCommand(message) !== null),
                    ))),
            )));
      const isSideChatHandoff = (handoff: OrchestrationV2ContextHandoff) =>
        projection.thread.lineage.sideChat === true &&
        ContextHandoffService.isSideChatContextHandoff(handoff);
      const handoffs = projection.contextHandoffs.filter(
        (handoff) =>
          !isSideChatHandoff(handoff) &&
          (handoff.transferId == null || !subagentResultTransfers.has(handoff.transferId)) &&
          isPendingForRun(handoff),
      );
      // Carried forward until a provider turn accepts it, also after a provider switch.
      const sideChatHandoff = projection.contextHandoffs.find(
        (handoff) =>
          isSideChatHandoff(handoff) &&
          handoff.delivery === undefined &&
          isPendingForRun(handoff, true),
      );
      const nativeForkTransfer = projection.contextTransfers.find(
        (transfer) =>
          transfer.type === "fork" &&
          transfer.targetThreadId === input.threadId &&
          transfer.targetRunId === run.id &&
          transfer.status === "pending" &&
          transfer.resolution === null,
      );
      if (
        rootNode === undefined ||
        attempt === undefined ||
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        message === undefined ||
        checkpointScope === undefined
      ) {
        return yield* new ProviderTurnStartError({
          runId,
          cause: `Run ${runId} is missing its execution projection state.`,
        });
      }
      const scopedAgentTask = String(projection.thread.id).startsWith("d4-action:");
      const d4AgentPrefix = Option.isSome(d4AgentContext)
        ? yield* d4AgentContext.value.prepare(
            projection.thread.id,
            run.modelSelection,
            providerThread.providerSessionId,
          )
        : null;
      const settleRunBeforeStart = Effect.fn("orchestrationV2.providerTurnStart.settleBeforeStart")(
        function* (input: {
          readonly signal: string;
          readonly status: "completed" | "failed";
          readonly now: DateTime.Utc;
          readonly startedAt?: DateTime.Utc;
          readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
          readonly itemProviderThreadId: OrchestrationV2ProviderThread["id"];
          readonly item:
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "error" }>,
                "type" | "title" | "failure"
              >
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
                "type" | "title" | "input" | "output" | "exitCode"
              >;
          readonly providerThreadUpdate?: OrchestrationV2ProviderThread;
        }) {
          const { now, status } = input;
          const started = input.startedAt === undefined ? {} : { startedAt: input.startedAt };
          const item: OrchestrationV2TurnItem = {
            id: idAllocator.derive.runSignalTurnItem({ runId, signal: input.signal }),
            threadId: projection.thread.id,
            runId,
            nodeId: rootNode.id,
            providerThreadId: input.itemProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal:
              Math.max(
                0,
                ...projection.turnItems
                  .filter((item) => item.runId === runId)
                  .map((item) => item.ordinal),
              ) + 1,
            status,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            ...input.item,
          };
          const eventPayloads = [
            { type: "turn-item.updated", payload: item },
            { type: "run.updated", payload: { ...run, status, ...started, completedAt: now } },
            {
              type: "run-attempt.updated",
              payload: { ...attempt, status, ...started, completedAt: now },
            },
            {
              type: "node.updated",
              payload: { ...rootNode, status, ...started, completedAt: now },
            },
            ...(input.providerThreadUpdate === undefined
              ? []
              : [
                  {
                    type: "provider-thread.updated" as const,
                    payload: input.providerThreadUpdate,
                  },
                ]),
          ] as const;
          const events = yield* Effect.forEach(eventPayloads, (event) =>
            Effect.gen(function* () {
              return {
                ...event,
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                threadId: projection.thread.id,
                runId,
                nodeId: rootNode.id,
                providerInstanceId: input.providerInstanceId,
                occurredAt: now,
              } satisfies OrchestrationV2DomainEvent;
            }),
          );
          yield* eventSink.writeIfRunCurrent({
            threadId: projection.thread.id,
            runId,
            activeAttemptId: attempt.id,
            expectedStatus: "starting",
            events,
          });
        },
      );
      const settings = yield* serverSettings.getSettings;
      // A refused scope is a final answer, not a transient fault. Throwing here
      // made the effect worker retry, give up, and leave the run `starting`
      // forever; settling it failed tells the caller why at once.
      const taskScope = yield* currentTaskScopeStatus(
        projection.thread.id,
        settings.d4Agent,
        settings,
      );
      const scopeRefusal =
        taskScope === null
          ? null
          : taskScope.status !== "ok"
            ? describeTaskScopeRefusal(taskScope)
            : taskScope.record.projectId !== projection.thread.projectId
              ? "This task belongs to a different project than its thread, so it cannot start."
              : null;
      if (scopeRefusal !== null) {
        yield* settleRunBeforeStart({
          signal: "task-scope-refused",
          status: "failed",
          now: yield* DateTime.now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "error",
            title: "Task scope refused",
            failure: makeProviderFailure({ message: scopeRefusal }),
          },
        });
        return;
      }
      const providers = yield* providerRegistry.getProviders;
      const nextOrdinal =
        Math.max(
          0,
          ...projection.turnItems
            .filter((item) => item.runId === runId)
            .map((item) => item.ordinal),
        ) + 1;
      if (
        d4AgentPrefix === null &&
        (yield* tryRunInlineResearchTurn({
          run,
          attempt,
          rootNode,
          message,
          providers,
          checkpointScopeId: checkpointScope.id,
          preparePrompt: (text) => Effect.succeed(withPersistedSkillsContext(text, message.text)),
          shareMemoContext: settings.research.shareMemoContext,
          nextOrdinal,
        }).pipe(
          Effect.provideContext(researchServices),
          Effect.provideService(EventSink.EventSinkV2, eventSink),
          Effect.provideService(IdAllocator.IdAllocatorV2, idAllocator),
        ))
      )
        return;
      const acceptedPrompt = extractTrailingEnabledSkillsContext(message.text).promptText;
      const pipelinePrompt = acceptedPrompt.startsWith("Ultrathink:\n")
        ? acceptedPrompt.slice("Ultrathink:\n".length)
        : acceptedPrompt;
      const pipelineKind =
        d4AgentPrefix !== null
          ? null
          : parseDevTrigger(pipelinePrompt) !== null
            ? "development"
            : parseResearchTrigger(pipelinePrompt) !== null
              ? "research"
              : null;
      const selectedProvider = providers.find(
        (provider) => provider.instanceId === run.providerInstanceId,
      );
      if (
        pipelineKind !== null &&
        (!selectedProvider ||
          !providerDriverSupportsPipelineOrchestration(String(selectedProvider.driver)))
      ) {
        yield* settleRunBeforeStart({
          signal: "pipeline-unavailable",
          status: "failed",
          now: yield* DateTime.now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "error",
            title: "Pipeline unavailable",
            failure: makeProviderFailure({
              message:
                "The selected provider cannot orchestrate pipelines because it does not expose MCP tools.",
            }),
          },
        });
        return;
      }
      const researchCandidates = deriveResearchProviderCandidatesFromProviders(providers);
      const manifest =
        d4AgentPrefix !== null
          ? null
          : buildResearchRunManifest(
              pipelinePrompt,
              settings.research,
              researchCandidates,
              settings.pipelineTargetPolicy,
            );
      if (manifest !== null) {
        const now = yield* DateTime.now;
        const written = yield* eventSink.writeIfRunCurrent({
          threadId: message.threadId,
          runId,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: message.threadId }),
              threadId: message.threadId,
              runId,
              nodeId: rootNode.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              type: "turn-item.updated",
              payload: {
                id: idAllocator.derive.runSignalTurnItem({ runId, signal: "research-manifest" }),
                threadId: message.threadId,
                runId,
                nodeId: rootNode.id,
                providerThreadId: providerThread.id,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: nextOrdinal,
                status: "completed",
                startedAt: now,
                updatedAt: now,
                completedAt: now,
                type: "system_notice",
                title: "Research run",
                message: `Research scenario ${manifest.scenario} started`,
                activity: {
                  kind: "research.run.started",
                  payload: { messageId: String(message.id), ...manifest },
                },
              },
            },
          ],
        });
        if (!written.committed) return;
      }
      const providerMessageText =
        d4AgentPrefix !== null
          ? message.text
          : withPersistedSkillsContext(
              expandProviderResearchMessage(
                expandProviderDevMessage(
                  acceptedPrompt,
                  settings.dev,
                  deriveDevProviderCandidates(providers),
                  settings.pipelineTargetPolicy,
                ),
                settings.research,
                researchCandidates,
                settings.pipelineTargetPolicy,
              ),
              message.text,
            );
      if (
        d4AgentPrefix === null &&
        message.attachments.length === 0 &&
        acceptedPrompt.trimStart().startsWith("/")
      ) {
        const isEmptyCompaction =
          acceptedPrompt.trim().toLowerCase() === "/compact" && !projection.hasConversation;
        // Preparing a run may already point the thread at a newly selected
        // provider. Account commands still belong to its last native session.
        const nativeThreads = new Map(
          projection.providerThreads
            .filter(
              (candidate) => candidate.ownerNodeId === null && candidate.nativeThreadRef !== null,
            )
            .map((candidate) => [candidate.id, candidate]),
        );
        const previousNativeRun = projection.runs.reduce<OrchestrationV2Run | undefined>(
          (previous, candidate) =>
            candidate.ordinal < run.ordinal &&
            candidate.providerThreadId !== null &&
            nativeThreads.has(candidate.providerThreadId) &&
            (previous === undefined || candidate.ordinal > previous.ordinal)
              ? candidate
              : previous,
          undefined,
        );
        const nativeThread = nativeThreads.get(
          previousNativeRun?.providerThreadId ??
            projection.thread.activeProviderThreadId ??
            providerThread.id,
        );
        const authInstanceId = nativeThread?.providerInstanceId ?? run.providerInstanceId;
        const authResult = isEmptyCompaction
          ? null
          : yield* Effect.result(
              providerAuth.tryHandlePromptCommand({
                instanceId: authInstanceId,
                text: projectComposerContextForProvider({
                  text: acceptedPrompt,
                  records: message.context?.records ?? [],
                }),
                hasAttachments: false,
              }),
            );
        if (isEmptyCompaction || authResult?._tag === "Failure" || authResult?.success) {
          const now = yield* DateTime.now;
          const failure = isEmptyCompaction
            ? makeProviderFailure({
                class: "validation_error",
                message: "Start a conversation before compacting this thread.",
              })
            : authResult?._tag === "Failure"
              ? makeProviderFailure({
                  class: "permission_error",
                  message: authResult.failure.detail,
                })
              : undefined;
          const status = failure === undefined ? "completed" : "failed";
          yield* settleRunBeforeStart({
            signal: isEmptyCompaction ? "empty-compaction" : "provider-sign-out",
            status,
            now,
            startedAt: now,
            providerInstanceId: authInstanceId,
            itemProviderThreadId: nativeThread?.id ?? providerThread.id,
            item:
              failure !== undefined
                ? {
                    type: "error",
                    title: isEmptyCompaction
                      ? "Cannot compact an empty thread"
                      : "Provider sign-out failed",
                    failure,
                  }
                : {
                    type: "command_execution",
                    title: "Provider signed out",
                    input: acceptedPrompt.trim(),
                    output: "Provider signed out",
                    exitCode: 0,
                  },
            providerThreadUpdate: {
              ...providerThread,
              status: providerThread.nativeThreadRef === null ? "not_loaded" : "idle",
              updatedAt: now,
            },
          });
          return;
        }
      }
      const settleStartFailure = Effect.fn("ProviderTurnStartService.settleStartFailure")(
        function* (failed: {
          readonly signal: string;
          readonly title: string;
          readonly error: Error;
          readonly message?: string;
        }) {
          const nestedCause = "cause" in failed.error ? failed.error.cause : undefined;
          yield* settleRunBeforeStart({
            signal: failed.signal,
            status: "failed",
            now: yield* DateTime.now,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: providerThread.id,
            item: {
              type: "error",
              title: failed.title,
              failure: makeProviderFailure({
                cause: failed.error,
                message:
                  failed.message ??
                  (nestedCause instanceof Error
                    ? nestedCause.message
                    : typeof nestedCause === "string"
                      ? nestedCause
                      : failed.error.message),
                class: "provider_error",
              }),
            },
          });
        },
      );
      const { worktreePath, branch } = projection.thread;
      if (worktreePath !== null && branch !== null) {
        const exists = yield* fileSystem
          .exists(worktreePath)
          .pipe(Effect.orElseSucceed(() => true));
        if (!exists && (yield* isManagedWorktreePath(worktreePath))) {
          const project = yield* projects.getById(projection.thread.projectId).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
          );
          if (project !== undefined) {
            yield* Effect.logWarning("provider turn start recreating missing worktree", {
              threadId: projection.thread.id,
              worktreePath,
              branch,
            });
            const recreateResult = yield* Effect.result(
              recreateMissingWorktree({
                cwd: project.workspaceRoot,
                worktreePath,
                branch,
              }).pipe(
                Effect.mapError((cause) =>
                  cause._tag === "WorktreeRecreateNoBaseError"
                    ? cause
                    : new WorktreeRecreateError({ worktreePath, branch, cause }),
                ),
              ),
            );
            if (recreateResult._tag === "Failure") {
              if (input.willRetry === true) return yield* recreateResult.failure;
              yield* settleStartFailure({
                signal: "worktree-recreate-failure",
                title: "Couldn't recreate thread workspace",
                error: recreateResult.failure,
                message: recreateResult.failure.message,
              });
              return;
            }
          }
        }
      }
      const selectInheritedBackgroundItems = (
        current: ProjectionStore.ProjectionRuntimeRecoveryState,
      ): ReturnType<typeof RunExecutionService.selectInheritedBackgroundTurnItems> =>
        RunExecutionService.selectInheritedBackgroundTurnItems({
          threadId: current.thread.id,
          currentProviderThreadId: providerThread.id,
          currentRunOrdinal: run.ordinal,
          runs: current.runs,
          turnItems: current.turnItems,
        });
      const inheritedBackgroundTurnItems = yield* projectionStore
        .getRuntimeRecoveryProjection(projection.thread.id)
        .pipe(Effect.map(selectInheritedBackgroundItems));
      const providerSessionId = providerThread.providerSessionId;
      const runControls = makeRunControls({
        threadId: projection.thread.id,
        runId: run.id,
        attemptId: attempt.id,
        providerThreadId: providerThread.id,
        runOrdinal: run.ordinal,
        inheritedBackgroundTurnItems,
      });
      const { isCurrentAttemptInStatus } = runControls;

      // A side chat shares its parent's worktree; the turn that gets its context asks before acting.
      const resolvedPolicy = yield* runtimePolicy
        .resolve({
          thread:
            projection.thread.lineage.sideChat === true &&
            (sideChatHandoff !== undefined ||
              !projection.runs.some((previous) => previous.ordinal < run.ordinal))
              ? { ...projection.thread, runtimeMode: "approval-required" }
              : projection.thread,
          modelSelection: run.modelSelection,
        })
        .pipe(Effect.result);
      if (resolvedPolicy._tag === "Failure") {
        const error = resolvedPolicy.failure;
        if (error._tag !== "RuntimePolicyAboveCeilingError") return yield* error;
        yield* settleStartFailure({
          signal: "runtime-mode-above-ceiling",
          title: "Thread mode is above the policy limit",
          error,
        });
        return;
      }
      const resolvedRuntimePolicy =
        d4AgentPrefix === null
          ? resolvedPolicy.success
          : {
              ...resolvedPolicy.success,
              runtimeMode: "approval-required" as const,
              interactionMode: "default" as const,
              toolPolicy: "d4-agent" as const,
              approvalPolicy: "never",
              sandboxPolicy: { type: "readOnly", networkAccess: false },
            };

      if (!(yield* isCurrentAttemptInStatus("starting"))) return;
      const existingSessionProjection = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      const failedRuns = new Map(
        projection.runs
          .filter(
            (previous) =>
              previous.ordinal < run.ordinal &&
              previous.providerThreadId === providerThread.id &&
              previous.status === "failed",
          )
          .map((previous) => [previous.activeAttemptId, previous] as const),
      );
      const abandonedTurns = projection.providerTurns.flatMap((turn) => {
        const previous = failedRuns.get(turn.runAttemptId);
        return turn.providerThreadId === providerThread.id &&
          turn.status === "running" &&
          previous !== undefined &&
          turn.nodeId === previous.rootNodeId
          ? [{ turn, run: previous }]
          : [];
      });
      const abandonedTurn = abandonedTurns.at(-1)?.turn;
      if (abandonedTurn !== undefined) {
        const liveSession = yield* providerSessions.get(providerSessionId);
        if (Option.isSome(liveSession)) {
          // Older versions could fail the run without stopping its provider.
          // Recover that exact turn before reusing its native conversation.
          const recovered = yield* Effect.result(
            liveSession.value.interruptTurn({
              providerThread,
              providerTurnId: abandonedTurn.id,
              requestRuntimeRestart: true,
            }),
          );
          if (recovered._tag === "Failure") {
            if (input.willRetry === true) return yield* recovered.failure;
            yield* settleStartFailure({
              signal: "provider-turn-recovery-failure",
              title: "Provider turn recovery failed",
              error: recovered.failure,
            });
            return;
          }
        }
        const completedAt = yield* DateTime.now;
        const repaired = yield* eventSink.writeIfRunCurrent({
          threadId: projection.thread.id,
          runId: run.id,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: yield* Effect.forEach(abandonedTurns, ({ turn, run: failedRun }) =>
            Effect.gen(function* () {
              return {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "provider-turn.updated" as const,
                threadId: projection.thread.id,
                runId: failedRun.id,
                nodeId: turn.nodeId,
                providerInstanceId: failedRun.providerInstanceId,
                occurredAt: completedAt,
                payload: { ...turn, status: "interrupted" as const, completedAt },
              };
            }),
          ),
        });
        if (!repaired.committed) return;
      }
      const sessionResult = yield* Effect.result(
        providerSessions.open({
          threadId: projection.thread.id,
          providerSessionId,
          modelSelection: run.modelSelection,
          runtimePolicy: resolvedRuntimePolicy,
          ...(existingSessionProjection === undefined
            ? {}
            : { resumeFromSession: existingSessionProjection }),
          ...(providerThread.nativeThreadRef?.nativeId == null
            ? {}
            : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
          ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
            ? {}
            : {
                initialProviderItemIdentityVersion:
                  providerThread.nativeMetadata.itemIdentityVersion,
              }),
        }),
      );
      if (sessionResult._tag === "Failure") {
        const failure = sessionResult.failure;
        const requiresSignIn =
          "cause" in failure &&
          isProviderAdapterOpenSessionError(failure.cause) &&
          failure.cause.requiresSignIn === true;
        if (input.willRetry === true && !requiresSignIn) return yield* failure;
        yield* settleStartFailure({
          signal: "provider-session-open-failure",
          title: "Provider session failed to open",
          error: sessionResult.failure,
        });
        return;
      }
      const session = sessionResult.success;
      if (!(yield* isCurrentAttemptInStatus("starting"))) return;
      // @effect-diagnostics-next-line effectFnOpportunity:off -- d4research code predating this style rule.
      const loadFromProvider = (
        load: Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapter.ProviderAdapterV2Error>,
      ) =>
        Effect.gen(function* () {
          const loaded = yield* Effect.result(load);
          if (loaded._tag === "Success") return loaded.success;
          if (input.willRetry === true) return yield* loaded.failure;
          yield* settleStartFailure({
            signal: "provider-thread-load-failure",
            title: "Provider turn failed to start",
            error: loaded.failure,
          });
          return undefined;
        });
      let effectiveHandoffs = handoffs;
      let resumeFellBack = false;
      const userText = projectComposerContextForProvider({
        text: providerMessageText,
        records: message.context?.records ?? [],
      });
      const saveHandoff = (text: string) =>
        handoffMemory.schedule({ text, threadId: input.threadId }, (receipt) =>
          Effect.gen(function* () {
            const current = yield* projectionStore.getThreadProjection(input.threadId);
            const now = yield* DateTime.now;
            yield* eventSink.write({
              events: [
                {
                  id: yield* idAllocator.allocate.event({ threadId: input.threadId }),
                  type: "turn-item.updated",
                  threadId: input.threadId,
                  runId,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: now,
                  payload: {
                    id: idAllocator.derive.runSignalTurnItem({
                      runId,
                      signal: "meko-handoff-failed",
                    }),
                    threadId: input.threadId,
                    runId,
                    nodeId: rootNode.id,
                    providerThreadId: providerThread.id,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal:
                      Math.max(
                        0,
                        ...current.turnItems
                          .filter((item) => item.runId === runId)
                          .map((item) => item.ordinal),
                      ) + 1,
                    status: "completed",
                    startedAt: now,
                    updatedAt: now,
                    completedAt: now,
                    type: "system_notice",
                    title: "Meko handoff save was not verified",
                    message: receipt.message,
                    activity: { kind: "handoff.meko.failed", payload: { status: receipt.status } },
                  },
                },
              ],
            });
          }).pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Meko handoff receipt could not be recorded."),
            ),
          ),
        );
      const attachedHandoff = extractTrailingProviderHandoffContext(
        extractTrailingEnabledSkillsContext(userText).promptText,
      ).handoff;
      if (
        d4AgentPrefix === null &&
        !scopedAgentTask &&
        settings.handoff.memoryBackend === "meko" &&
        attachedHandoff !== null
      )
        yield* saveHandoff(attachedHandoff.summary);
      // Codex and Claude parse /goal from the prompt, so it goes verbatim and history waits a turn.
      const goalDriver = session.driver === "codex" || session.driver === "claudeAgent";
      const goalCommand = goalDriver && parseGoalCommand(message) !== null;
      // The provider turn marks cancellation work delivered; restart continuations use their own text or resume natively.
      const noteContinuation = isRestartNoteContinuation(
        run,
        projection.runs,
        projection.providerTurns,
        projection.attempts,
      );
      const restartCancelledWork = pendingRestartCancelledBackgroundWork({
        runs: projection.runs,
        providerTurns: projection.providerTurns,
        compactionMessageIds: new Set(
          projection.messages
            .filter(
              (candidate) =>
                isCompactionCommandMessage(candidate) ||
                (goalDriver && parseGoalCommand(candidate) !== null),
            )
            .map((candidate) => candidate.id),
        ),
        run,
        attempts: projection.attempts,
      });
      // A pipeline run cut short by a restart, a stop, or a failure is
      // continued by the next plain message; the server ledger tells the
      // orchestrator what already ran so it does not delegate it again.
      const resumeNote =
        d4AgentPrefix !== null
          ? ""
          : yield* Effect.gen(function* () {
              const project = yield* projects.getById(projection.thread.projectId).pipe(
                Effect.map(Option.getOrUndefined),
                Effect.orElseSucceed(() => undefined),
              );
              return yield* buildResumeNote({
                threadId: projection.thread.id,
                currentRunId: run.id,
                runs: projection.runs,
                messages: projection.messages,
                workspaceRoot: project?.workspaceRoot,
              });
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            );
      const restartNote = [
        restartCancelledWork.length === 0
          ? ""
          : restartCancelledBackgroundWorkNote(restartCancelledWork),
        resumeNote,
      ]
        .filter((part) => part !== "")
        .join("\n\n");
      const tokenCap = yield* handoffTokenCapConfig.pipe(
        Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
      );
      const handoffContextForThread = (loadedProviderThread: OrchestrationV2ProviderThread) => {
        const measuredContext = latestNativeContextUsage(projection, providerThread);
        const previousSelection =
          measuredContext?.modelSelection ??
          projection.runs.findLast(
            (source) =>
              source.ordinal < run.ordinal &&
              source.startedAt !== null &&
              source.providerThreadId === providerThread.id,
          )?.modelSelection;
        const sameSelection =
          previousSelection === undefined ||
          modelSelectionsEqual(previousSelection, run.modelSelection);
        const sameNativeThread =
          loadedProviderThread.nativeThreadRef?.nativeId ===
          providerThread.nativeThreadRef?.nativeId;
        const threadUsage = loadedProviderThread.contextUsage ?? providerThread.contextUsage;
        const previousUsage = measuredContext
          ? { ...threadUsage, ...measuredContext.usage }
          : threadUsage;
        const reuseTelemetry =
          sameSelection ||
          (previousSelection !== undefined &&
            session.canReuseContextUsage?.(previousSelection, run.modelSelection) === true);
        const knownModelWindow = session.getModelContextWindow?.(
          run.modelSelection,
          resolvedRuntimePolicy.cwd,
        );
        const handoffUsage = contextUsageForHandoff({
          sameNativeThread,
          sameSelection,
          reuseTelemetry,
          previousUsage,
          knownModelWindow,
        });
        const settledHandoffs = projection.contextHandoffs.filter(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === loadedProviderThread.nativeThreadRef?.nativeId &&
            handoff.delivery?.status !== "pending",
        );
        const deliveredItemIds = new Set(
          settledHandoffs.flatMap((handoff) => handoff.delivery?.itemIds ?? []),
        );
        const coveredItemIds = new Set([
          ...deliveredItemIds,
          ...settledHandoffs.flatMap((handoff) => handoff.delivery?.omittedItemIds ?? []),
        ]);
        const deliveredAttemptIds = new Set(
          projection.providerTurns.map((turn) => turn.runAttemptId),
        );
        const acceptedAttempts = projection.attempts.filter(
          (source) =>
            source.providerThreadId === providerThread.id && deliveredAttemptIds.has(source.id),
        );
        const nativeInputRunIds = new Set(
          acceptedAttempts
            .filter(
              (source) =>
                source.nativeThreadId !== undefined &&
                source.nativeThreadId === loadedProviderThread.nativeThreadRef?.nativeId,
            )
            .map((source) => source.runId),
        );
        const legacyInputRunIds = new Set(
          acceptedAttempts
            .filter((source) => source.nativeThreadId === undefined)
            .map((source) => source.runId),
        );
        const legacyRecoveredRunIds = new Set(
          projection.runs
            .filter(
              (source) =>
                source.providerThreadId === providerThread.id &&
                settledHandoffs.some(
                  (handoff) =>
                    handoff.strategy === "full_thread_summary" &&
                    handoff.fromProviderThreadIds.includes(providerThread.id) &&
                    source.ordinal >= handoff.coveredRunOrdinals.from &&
                    source.ordinal <= handoff.coveredRunOrdinals.to,
                ),
            )
            .map((source) => source.id),
        );
        // Row identity survives recovery; only accepted native input and delivered history occupy the new session.
        const nativeContextEstimate = Effect.gen(function* () {
          return sameNativeThread
            ? (yield* projectionStore.getTurnStartHistory(input.threadId)).reduce((sum, item) => {
                const acceptedNatively =
                  item.providerThreadId === providerThread.id &&
                  item.runId !== null &&
                  (nativeInputRunIds.has(item.runId) ||
                    (legacyInputRunIds.has(item.runId) &&
                      !coveredItemIds.has(item.id) &&
                      !legacyRecoveredRunIds.has(item.runId)));
                if (item.runId === run.id || (!acceptedNatively && !deliveredItemIds.has(item.id)))
                  return sum;
                const historical = historicalMessage(item);
                const nativeAttachments =
                  item.type === "user_message" && acceptedNatively
                    ? attachmentTokenAllowance(item.attachments)
                    : 0;
                return (
                  sum +
                  (historical === null ? 0 : Buffer.byteLength(historical.text)) +
                  nativeAttachments
                );
              }, 0)
            : 0;
        });
        const modelContextWindow =
          knownModelWindow ??
          (handoffUsage !== null || reuseTelemetry ? previousUsage?.maxTokens : undefined);
        const budgetProviderThread = {
          ...loadedProviderThread,
          contextUsage: handoffUsage,
        };
        // The resume fallback summary already covers every earlier run in order. A
        // retry copy after it would rank older missed requests as the newest history.
        const missedRuns = projection.runs.filter(
          (source) =>
            !resumeFellBack &&
            source.ordinal < run.ordinal &&
            source.providerThreadId === providerThread.id &&
            (source.status === "failed" || source.status === "interrupted") &&
            !deliveredAttemptIds.has(source.activeAttemptId),
        );
        const missedRunIds = new Set(missedRuns.map((source) => source.id));
        return {
          modelContextWindow,
          budgetProviderThread,
          nativeContextEstimate,
          sameNativeThread,
          handoffUsage,
          deliveredItemIds,
          coveredItemIds,
          acceptedAttempts,
          nativeInputRunIds,
          legacyInputRunIds,
          missedRuns,
          missedRunIds,
          budget: Effect.gen(function* () {
            return handoffBudget({
              tokenCap,
              modelContextWindow,
              userText: restartNote === "" ? userText : `${restartNote}\n\n${userText}`,
              attachments: message.attachments,
              providerThread: budgetProviderThread,
              nativeContextEstimate:
                budgetProviderThread.contextUsage?.usedTokens === undefined
                  ? yield* nativeContextEstimate
                  : 0,
            });
          }),
        };
      };
      const prepareRetryHandoff = Effect.fn("ProviderTurnStartService.prepareRetryHandoff")(
        function* (context: ReturnType<typeof handoffContextForThread>) {
          const { missedRunIds, coveredItemIds, missedRuns } = context;
          const missedItems =
            missedRunIds.size === 0
              ? []
              : (yield* projectionStore.getTurnStartHistory(input.threadId, [
                  ...missedRunIds,
                ])).filter(
                  (item) =>
                    item.runId !== null &&
                    missedRunIds.has(item.runId) &&
                    !coveredItemIds.has(item.id) &&
                    historicalMessage(item) !== null,
                );
          const retryHandoff =
            missedItems.length === 0
              ? []
              : [
                  yield* contextHandoffService.prepareProviderHandoff({
                    threadId: projection.thread.id,
                    targetRunId: run.id,
                    transferId: null,
                    fromProviderThreadIds: [providerThread.id],
                    toProviderThreadId: providerThread.id,
                    fromProviderInstanceId: run.providerInstanceId,
                    toProviderInstanceId: run.providerInstanceId,
                    coveredRunOrdinals: {
                      from: missedRuns[0]!.ordinal,
                      to: missedRuns.at(-1)!.ordinal,
                    },
                    strategy: "delta_since_target_last_seen",
                    items: missedItems,
                    runs: projection.runs,
                    createdAt: yield* DateTime.now,
                  }),
                ];
          return retryHandoff;
        },
      );
      let resumedRetryHandoff: ReadonlyArray<OrchestrationV2ContextHandoff> | undefined;
      let resumedHandoffContext: ReturnType<typeof handoffContextForThread> | undefined;
      let portableForkFallback: OrchestrationV2ContextHandoff | undefined;
      const loadedProviderThread = yield* Effect.gen(function* () {
        if (nativeForkTransfer !== undefined) {
          const sourceProjection = yield* projectionStore.getThreadRecords(
            nativeForkTransfer.sourceThreadId,
            ["runs", "providerThreads", "attempts", "providerTurns"],
          );
          const sourceRun = sourceProjection.runs.find(
            (candidate) => candidate.id === nativeForkTransfer.sourcePoint.runId,
          );
          const sourceProviderThread = sourceProjection.providerThreads.find(
            (candidate) => candidate.id === sourceRun?.providerThreadId,
          );
          const sourceAttempt = sourceProjection.attempts.find(
            (candidate) => candidate.id === sourceRun?.activeAttemptId,
          );
          const sourceProviderTurn =
            latestProviderTurnForAttempt(sourceProjection.providerTurns, sourceAttempt?.id) ??
            sourceProjection.providerTurns.find(
              (candidate) => candidate.id === sourceAttempt?.providerTurnId,
            );
          if (sourceRun === undefined || sourceProviderThread === undefined) {
            return yield* new ProviderTurnStartError({
              runId,
              cause: `Native fork transfer ${nativeForkTransfer.id} has no source provider execution.`,
            });
          }
          // Providers refuse to fork a busy thread, so a source that started a turn after
          // dispatch planned this fork gets the portable context dispatch gives a busy source.
          const sourceBusy = sourceProjection.runs.some(
            (candidate) => candidate.ordinal > sourceRun.ordinal && isActiveRun(candidate),
          );
          if (!sourceBusy) {
            return yield* loadFromProvider(
              session.forkThread({
                sourceProviderThread,
                sourceProviderTurns: sourceProjection.providerTurns,
                targetThreadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
                ...(sourceProviderTurn === undefined
                  ? {}
                  : { providerTurnId: sourceProviderTurn.id }),
              }),
            );
          }
          const sourceItems = yield* ContextHandoffService.readForkHistoryItems(
            projectionStore,
            sourceProjection,
            sourceRun,
          );
          const createdAt = yield* DateTime.now;
          const handoff = yield* contextHandoffService.prepareProviderHandoff({
            threadId: projection.thread.id,
            targetRunId: run.id,
            transferId: nativeForkTransfer.id,
            fromProviderThreadIds: [sourceProviderThread.id],
            toProviderThreadId: providerThread.id,
            fromProviderInstanceId: sourceRun.providerInstanceId,
            toProviderInstanceId: run.providerInstanceId,
            coveredRunOrdinals: ContextHandoffService.visibleDeltaRunOrdinals(
              sourceProjection,
              sourceItems,
            ),
            strategy: "full_thread_summary",
            items: sourceItems,
            runs: sourceProjection.runs,
            createdAt,
          });
          const loaded = yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              existingProviderThread: { ...providerThread, forkedFrom: null },
            }),
          );
          if (loaded === undefined) return undefined;
          portableForkFallback = handoff;
          effectiveHandoffs = [handoff, ...effectiveHandoffs];
          yield* eventSink.write({
            events: [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-handoff.updated",
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: createdAt,
                payload: handoff,
              },
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-transfer.updated",
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: createdAt,
                payload: {
                  ...nativeForkTransfer,
                  targetProviderInstanceId: run.providerInstanceId,
                  status: "resolved_portable",
                  resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                  error: null,
                  updatedAt: createdAt,
                },
              },
            ],
          });
          return loaded;
        }
        if (providerThread.nativeThreadRef === null) {
          // Hand the run's provider thread to the adapter so it adopts this
          // row's identity when attaching native state. An adapter that mints
          // its own row instead leaves two live rows per app thread, and
          // `activeProviderThreadId` then flaps between them on every update.
          return yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              existingProviderThread: providerThread,
            }),
          );
        }
        const uncertainDelivery = projection.contextHandoffs.some(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
            handoff.delivery?.status === "pending",
        );
        const resumed = yield* Effect.result(
          uncertainDelivery
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: "Uncertain native history injection",
                }),
              )
            : session.resumeThread({
                providerThread,
                threadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
              }),
        );
        if (resumed._tag === "Success") {
          return resumed.success;
        }

        yield* Effect.logWarning("Provider resume failed; attempting a fresh native session", {
          driver: session.driver,
          providerThreadId: providerThread.id,
          runId,
          reason: uncertainDelivery ? "uncertain_history_delivery" : "resume_failed",
          errorTag: resumed.failure._tag,
        });
        const replacement = yield* loadFromProvider(
          session.ensureThread({
            threadId: projection.thread.id,
            title: projection.thread.title,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            providerSessionId,
            // The native ref is dropped so the adapter binds a fresh native
            // session instead of retrying the resume that just failed, while
            // still adopting this row's identity.
            existingProviderThread: { ...providerThread, nativeThreadRef: null },
          }),
        );
        if (replacement === undefined) return undefined;
        const transferId = yield* idAllocator.allocate.contextTransfer({
          sourceThreadId: projection.thread.id,
          targetThreadId: projection.thread.id,
          type: "provider_resume_fallback",
        });
        const createdAt = yield* DateTime.now;
        const handoff = yield* contextHandoffService.prepareProviderHandoff({
          threadId: projection.thread.id,
          targetRunId: run.id,
          transferId,
          fromProviderThreadIds: [providerThread.id],
          toProviderThreadId: providerThread.id,
          fromProviderInstanceId: providerThread.providerInstanceId,
          toProviderInstanceId: run.providerInstanceId,
          coveredRunOrdinals: { from: 1, to: Math.max(1, run.ordinal - 1) },
          strategy: "full_thread_summary",
          runs: projection.runs,
          items: (yield* projectionStore.getTurnStartHistory(input.threadId)).filter(
            (item) =>
              item.runId === null ||
              projection.runs.some(
                (source) => source.id === item.runId && source.ordinal < run.ordinal,
              ),
          ),
          createdAt,
        });
        effectiveHandoffs = [handoff, ...effectiveHandoffs];
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-handoff.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: handoff,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-transfer.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: {
                id: transferId,
                type: "provider_handoff",
                sourceThreadId: projection.thread.id,
                targetThreadId: projection.thread.id,
                sourcePoint: { threadId: projection.thread.id },
                basePoint: null,
                sourceProviderInstanceId: providerThread.providerInstanceId,
                targetProviderInstanceId: run.providerInstanceId,
                targetRunId: run.id,
                status: "resolved_portable",
                resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                createdBy: "system",
                error: null,
                createdAt,
                updatedAt: createdAt,
                consumedAt: null,
              },
            },
          ],
        });
        return replacement;
      });
      if (loadedProviderThread === undefined) return;
      if (!(yield* isCurrentAttemptInStatus("starting"))) {
        return;
      }
      const now = yield* DateTime.now;
      const handoffContext = resumedHandoffContext ?? handoffContextForThread(loadedProviderThread);
      const {
        sameNativeThread,
        handoffUsage,
        deliveredItemIds,
        acceptedAttempts,
        nativeInputRunIds,
        legacyInputRunIds,
        modelContextWindow,
        budgetProviderThread,
        nativeContextEstimate,
      } = handoffContext;
      const retryHandoff = resumedRetryHandoff ?? (yield* prepareRetryHandoff(handoffContext));
      const runningProviderThread: OrchestrationV2ProviderThread = {
        ...loadedProviderThread,
        contextUsage: handoffUsage,
        id: providerThread.id,
        driver: session.driver,
        providerInstanceId: run.providerInstanceId,
        providerSessionId,
        appThreadId: projection.thread.id,
        ownerNodeId: providerThread.ownerNodeId,
        firstRunOrdinal: providerThread.firstRunOrdinal ?? run.ordinal,
        lastRunOrdinal: run.ordinal,
        handoffIds:
          portableForkFallback === undefined
            ? providerThread.handoffIds
            : [...providerThread.handoffIds, portableForkFallback.id],
        forkedFrom: portableForkFallback === undefined ? providerThread.forkedFrom : null,
        status: "active",
        createdAt: providerThread.createdAt,
        updatedAt: now,
      };
      const runningRun: OrchestrationV2Run = {
        ...run,
        status: "running",
        startedAt: now,
      };
      const runningAttempt: OrchestrationV2RunAttempt = {
        ...attempt,
        ...(runningProviderThread.nativeThreadRef?.nativeId == null
          ? {}
          : { nativeThreadId: runningProviderThread.nativeThreadRef.nativeId }),
        status: "running",
        startedAt: now,
      };
      const runningRootNode: OrchestrationV2ExecutionNode = {
        ...rootNode,
        status: "running",
        startedAt: now,
      };
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: yield* idAllocator.allocate.event({
            threadId: projection.thread.id,
            providerSessionId,
          }),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: session.providerSession,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningProviderThread,
        },
        ...(nativeForkTransfer === undefined ||
        portableForkFallback !== undefined ||
        runningProviderThread.nativeThreadRef === null
          ? []
          : [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-transfer.updated" as const,
                threadId: projection.thread.id,
                runId: run.id,
                driver: session.driver,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...nativeForkTransfer,
                  targetProviderInstanceId: run.providerInstanceId,
                  targetRunId: run.id,
                  status: "consumed" as const,
                  resolution: {
                    strategy: "native_fork" as const,
                    providerThreadRef: runningProviderThread.nativeThreadRef,
                  },
                  error: null,
                  updatedAt: now,
                  consumedAt: now,
                },
              },
            ]),
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRun,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run-attempt.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningAttempt,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "node.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRootNode,
        },
      ];
      const runningWrite = yield* eventSink.writeIfRunCurrent({
        threadId: projection.thread.id,
        runId: run.id,
        activeAttemptId: attempt.id,
        expectedStatus: "starting",
        events,
      });
      if (!runningWrite.committed) {
        return;
      }
      const routableSubagents = projection.subagents.filter((subagent) =>
        RunExecutionService.canRouteRelatedSubagent(subagent.status),
      );
      const nativeThreadHasTurns =
        nativeInputRunIds.size > 0 ||
        (legacyInputRunIds.size > 0 &&
          sameNativeThread &&
          !acceptedAttempts.some((source) => source.nativeThreadId !== undefined));
      const brainContext =
        d4AgentPrefix !== null ||
        scopedAgentTask ||
        !settings.secondBrain.path ||
        !settings.secondBrain.injection.enabled ||
        message.text.trimStart().startsWith("/")
          ? null
          : yield* Effect.gen(function* () {
              const brainProject = yield* projects.getById(projection.thread.projectId).pipe(
                Effect.map(Option.getOrUndefined),
                Effect.orElseSucceed(() => undefined),
              );
              return yield* brain.buildTurnContext({
                userText: message.text,
                includeCore:
                  !nativeThreadHasTurns || effectiveHandoffs.length > 0 || retryHandoff.length > 0,
                providerThreadId: providerThread.id,
                ...(brainProject
                  ? { projectTitle: brainProject.title, workspacePath: brainProject.workspaceRoot }
                  : {}),
              });
            }).pipe(
              Effect.timeout("1500 millis"),
              Effect.catchCause(() =>
                Effect.logWarning("Second brain context unavailable").pipe(Effect.as(null)),
              ),
            );
      const brainText = brainContext ? SecondBrainService.formatTurnContext(brainContext) : "";
      const recovery = makeHandoffCompactionRecovery(session);
      let recoveredNativeContext = false;
      const persistHandoff = Effect.fn("ProviderTurnStartService.persist")(function* (
        handoff: OrchestrationV2ContextHandoff,
      ) {
        const updatedAt = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({
                threadId: projection.thread.id,
              }),
              type: "context-handoff.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: updatedAt,
              payload: { ...handoff, updatedAt },
            },
          ],
        });
      });
      // @effect-diagnostics-next-line effectFnOpportunity:off -- d4research code predating this style rule.
      const startWithHandoffs = (
        turnInput: Parameters<typeof session.startTurn>[0],
        compact = false,
      ) =>
        Effect.gen(function* () {
          const compression =
            d4AgentPrefix === null && !scopedAgentTask
              ? settings.handoff.contextCompression
              : { ...settings.handoff.contextCompression, mode: "bounded" as const };
          compact = compact && d4AgentPrefix === null && !scopedAgentTask;
          let deliveryHandoffs = [...effectiveHandoffs, ...retryHandoff];
          if (compression.mode !== "bounded" && deliveryHandoffs.length > 0) {
            // Preparation is pure and bounded. Recover intact covered items here,
            // in the effect worker, before choosing direct or smart delivery.
            const history = yield* projectionStore.getTurnStartHistory(input.threadId);
            deliveryHandoffs = deliveryHandoffs.map((handoff) =>
              restoreHandoffHistory(handoff, history, projection.runs),
            );
          }
          if (
            d4AgentPrefix === null &&
            !scopedAgentTask &&
            settings.handoff.memoryBackend === "meko" &&
            deliveryHandoffs.length > 0
          ) {
            yield* saveHandoff(
              deliveryHandoffs
                .map((handoff) => handoff.summaryText)
                .join("\n\n")
                .slice(0, 60_000),
            );
          }
          const deliver = () =>
            deliverContextHandoffs({
              handoffs: deliveryHandoffs,
              mode: compression.mode,
              compact: (transcript, maxCharacters) =>
                compressHandoffContextLocal({
                  transcript,
                  task: userText,
                  model: compression.localModel,
                  judgeModel: compression.judgeModel || compression.localModel,
                  ...(compression.judgeBaseUrl ? { judgeBaseUrl: compression.judgeBaseUrl } : {}),
                  ...(compression.secondaryJudgeModel && compression.secondaryJudgeBaseUrl
                    ? {
                        secondaryJudge: {
                          model: compression.secondaryJudgeModel,
                          baseUrl: compression.secondaryJudgeBaseUrl,
                        },
                      }
                    : {}),
                  maxInputCharacters: compression.maxInputCharacters,
                  maxOutputCharacters: Math.min(maxCharacters, compression.maxOutputCharacters),
                  customPrompt: compression.customPrompt,
                }),
              deferInline: compact || goalCommand,
              providerThread: runningProviderThread,
              budget: Effect.gen(function* () {
                return handoffBudget({
                  tokenCap: compression.mode === "direct" ? Number.MAX_SAFE_INTEGER : tokenCap,
                  modelContextWindow,
                  userText: restartNote === "" ? userText : `${restartNote}\n\n${userText}`,
                  attachments: message.attachments,
                  providerThread: budgetProviderThread,
                  nativeContextEstimate:
                    budgetProviderThread.contextUsage?.usedTokens === undefined
                      ? yield* nativeContextEstimate
                      : 0,
                });
              }),
              alreadyDeliveredItemIds: deliveredItemIds,
              ...(session.injectHistory === undefined
                ? {}
                : {
                    inject: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                      session.injectHistory!({
                        providerThread: runningProviderThread,
                        ...history,
                      }),
                  }),
              // @effect-diagnostics-next-line effectFnOpportunity:off -- d4research code predating this style rule.
              persist: (handoff) =>
                Effect.gen(function* () {
                  const updatedAt = yield* DateTime.now;
                  yield* eventSink.write({
                    events: [
                      {
                        id: yield* idAllocator.allocate.event({
                          threadId: projection.thread.id,
                        }),
                        type: "context-handoff.updated",
                        threadId: projection.thread.id,
                        runId: run.id,
                        providerInstanceId: run.providerInstanceId,
                        occurredAt: updatedAt,
                        payload: { ...handoff, updatedAt },
                      },
                    ],
                  });
                }),
            });
          const delivery = yield* deliver().pipe(
            Effect.catchTags({
              // @effect-diagnostics-next-line effectFnOpportunity:off -- d4research code predating this style rule.
              ContextHandoffBudgetError: (error) =>
                Effect.gen(function* () {
                  if (
                    compact ||
                    d4AgentPrefix !== null ||
                    scopedAgentTask ||
                    !nativeThreadHasTurns ||
                    handoffBudget({
                      tokenCap,
                      modelContextWindow,
                      userText: restartNote === "" ? userText : `${restartNote}\n\n${userText}`,
                      attachments: message.attachments,
                      providerThread: { ...budgetProviderThread, contextUsage: null },
                      nativeContextEstimate: 0,
                    }) === 0 ||
                    !(yield* isCurrentAttemptInStatus("running"))
                  )
                    return yield* error;
                  budgetProviderThread.contextUsage = yield* recovery.compact(turnInput);
                  recoveredNativeContext = true;
                  if (!(yield* isCurrentAttemptInStatus("running")))
                    return { context: "", delivered: Effect.void, unsent: Effect.void };
                  // Delivery rejected before any persistence/injection. Retry only this phase;
                  // never retry startTurn, whose acknowledgement can be ambiguous.
                  return yield* deliver();
                }),
            }),
          );
          if (!(yield* isCurrentAttemptInStatus("running"))) return;
          if (
            session.providerSession.capabilities.context.requiresAppHistory &&
            session.injectHistory
          ) {
            yield* session.injectHistory({
              providerThread: runningProviderThread,
              messages: selectAppProviderHistory(
                yield* projectionStore.getTurnStartHistory(input.threadId),
                projection.runs,
                run.id,
              ),
              context: "",
            });
          }
          const start = compact ? session.compactThread! : session.startTurn;
          // Like history, the side chat context waits for a turn that sends a prompt.
          const sideChatContext =
            sideChatHandoff === undefined || compact || goalCommand
              ? ""
              : sideChatHandoff.summaryText;
          const context = [
            delivery.context,
            sideChatContext,
            restartNote,
            compact || goalCommand ? "" : brainText,
          ]
            .filter((part) => part !== "")
            .join("\n\n");
          const { restartContinuationOfRunId: _resumedRunId, ...promptedInput } = turnInput;
          yield* start({
            ...(noteContinuation ? promptedInput : turnInput),
            ...(recoveredNativeContext
              ? { providerTurnOrdinal: turnInput.providerTurnOrdinal + 1 }
              : {}),
            message: {
              ...turnInput.message,
              text:
                d4AgentPrefix !== null
                  ? `${d4AgentPrefix}\n\n${context === "" ? "" : `${context}\n\n`}User message:\n${userText}`
                  : goalCommand
                    ? userText
                    : withInlineContext(context, userText),
            },
          }).pipe(
            // A pending marker would make the next turn abandon this native
            // session, though the refused prompt never reached it.
            Effect.tapError((error) =>
              refusedBeforePrompt(error)
                ? delivery.unsent.pipe(
                    Effect.catchCause(() =>
                      Effect.logWarning("Failed to restore unsent context handoffs", {
                        runId: run.id,
                      }),
                    ),
                  )
                : Effect.void,
            ),
          );
          if (!compact && brainContext)
            yield* brain.markContextDelivered(brainContext).pipe(
              Effect.timeout("100 millis"),
              Effect.catchCause(() =>
                Effect.logWarning("Second brain delivery receipt unavailable"),
              ),
            );
          // After provider acceptance, failed delivery bookkeeping must not stop live ingestion.
          const nativeThreadId = runningProviderThread.nativeThreadRef?.nativeId;
          yield* Effect.forEach(
            [
              delivery.delivered,
              ...(sideChatContext === "" || sideChatHandoff === undefined || nativeThreadId == null
                ? []
                : [
                    persistHandoff({
                      ...sideChatHandoff,
                      toProviderThreadId: runningProviderThread.id,
                      delivery: { nativeThreadId, status: "inline" as const, itemIds: [] },
                    }),
                  ]),
            ],
            (record) =>
              record.pipe(
                Effect.catchCause(() =>
                  Effect.logWarning("Failed to record accepted context handoff delivery", {
                    runId: run.id,
                    deliveryStatus: "pending",
                  }),
                ),
              ),
            { discard: true },
          );
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ProviderAdapterTurnStartError"
              ? cause
              : new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId: run.id,
                  cause,
                }),
          ),
        );
      const deliverySession =
        d4AgentPrefix === null &&
        !session.providerSession.capabilities.context.requiresAppHistory &&
        effectiveHandoffs.length === 0 &&
        retryHandoff.length === 0 &&
        sideChatHandoff === undefined &&
        restartNote === "" &&
        brainText === "" &&
        !noteContinuation
          ? session
          : makeDeliverySession(recovery.session, startWithHandoffs);
      const mcpSession = yield* mcpProviderSessions.read(message.threadId);
      if (mcpSession !== undefined) {
        yield* setActiveMcpTurn(mcpSession.providerSessionId, TurnId.make(run.id));
      }
      return runExecution.startRootRun({
        commandId: CommandId.make(`command:effect:provider-turn.start:${run.id}`),
        appThread: projection.thread,
        providerSessionId,
        session: deliverySession,
        run: runningRun,
        rootNode: runningRootNode,
        checkpointScope,
        providerThread: runningProviderThread,
        attempt: runningAttempt,
        attemptId: attempt.id,
        loadInheritedBackgroundTurnItems: runControls.loadInheritedBackgroundTurnItems,
        relatedThreadIds: routableSubagents.flatMap((subagent) =>
          subagent.childThreadId === null ? [] : [subagent.childThreadId],
        ),
        relatedProviderThreadIds: routableSubagents.flatMap((subagent) =>
          subagent.providerThreadId === null ? [] : [subagent.providerThreadId],
        ),
        providerTurnOrdinal:
          Math.max(
            0,
            ...projection.providerTurns
              .filter((turn) => turn.providerThreadId === providerThread.id)
              .map((turn) => turn.ordinal),
          ) + 1,
        nativeThreadHasTurns,
        shouldStartProviderTurn: runControls.shouldStartProviderTurn,
        shouldFinalizeRun: runControls.shouldFinalizeRun,
        hasUnpairedRunInterruptRequest: runControls.hasUnpairedRunInterruptRequest,
        message: {
          messageId: message.id,
          text: userText,
          attachments: message.attachments,
          createdBy: message.createdBy,
          creationSource: message.creationSource,
          ...(message.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: message.scheduledTaskId }),
          ...(message.senderThreadId === undefined
            ? {}
            : { senderThreadId: message.senderThreadId }),
        },
        modelSelection: run.modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
      });
    });

    return ProviderTurnStartServiceV2.of({
      start: (input) =>
        Effect.gen(function* () {
          // Storage cleanup removes worktrees under the same lease. Only startup
          // holds it; the provider turn runs after it is released.
          const { thread } = yield* projectionStore.getThreadRecords(input.threadId, []);
          const providerTurn = yield* thread.worktreePath === null
            ? start(input)
            : withWorkspaceLease(path.resolve(thread.worktreePath), start(input));
          if (providerTurn !== undefined) yield* providerTurn;
        }).pipe(
          Effect.mapError((cause) =>
            isProviderTurnStartError(cause)
              ? cause
              : new ProviderTurnStartError({ runId: input.runId, cause }),
          ),
        ),
    });
  }),
).pipe(Layer.provide(HandoffMemory.layer.pipe(Layer.provide(FetchHttpClient.layer))));
