import {
  CommandId,
  D4AgentError,
  MessageId,
  ThreadId,
  type D4BrainContext,
  type ModelSelection,
  type ProjectId,
  type ResearchPromptFile,
} from "@d4research/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Catalog from "./PipelineCatalog.ts";
import { projectActionInScope } from "./brainScope.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

export interface PipelineAction {
  readonly type: "pipeline" | "research";
  readonly pipelineId: string;
  readonly projectId: ProjectId;
  readonly text: string;
  readonly modelSelection: ModelSelection;
}
export interface PreparedPipeline {
  readonly pipelineId: string;
  readonly projectId: ProjectId;
  readonly text: string;
  readonly modelSelection: ModelSelection;
  readonly pipelinePrompt: string;
  readonly promptFiles: ReadonlyArray<ResearchPromptFile>;
  readonly scenarioHash: string;
}
export interface ScopedPipeline {
  readonly pipelineId: string;
  readonly kind: Catalog.PipelineKind;
  readonly name: string;
  readonly active: boolean;
  readonly projectId: ProjectId | null;
}
export class D4AgentPipelines extends Context.Service<
  D4AgentPipelines,
  {
    readonly list: (
      context: D4BrainContext,
    ) => Effect.Effect<ReadonlyArray<ScopedPipeline>, D4AgentError>;
    readonly prepare: (
      action: PipelineAction,
      context: D4BrainContext,
    ) => Effect.Effect<PreparedPipeline, D4AgentError>;
    readonly execute: (input: {
      readonly actionId: string;
      readonly context: D4BrainContext;
      readonly prepared: PreparedPipeline;
      readonly onCreated?: (threadId: ThreadId) => Effect.Effect<void, D4AgentError>;
    }) => Effect.Effect<ThreadId, D4AgentError>;
  }
>()("d4research/d4Agent/D4AgentPipelines") {}

const unavailable = () => new D4AgentError({ reason: "action-unavailable" });
const scopeError = () => new D4AgentError({ reason: "context" });

const make = Effect.gen(function* () {
  const catalog = yield* Catalog.PipelineCatalog;
  const settings = yield* ServerSettingsService;
  const threads = yield* Threads.ThreadManagementService;
  const list = Effect.fn("D4AgentPipelines.list")(function* (context: D4BrainContext) {
    const config = (yield* settings.getSettings.pipe(Effect.mapError(unavailable))).d4Agent;
    const entries = yield* catalog.list().pipe(Effect.mapError(unavailable));
    return entries.flatMap((entry) => {
      const pipelineId = `${entry.kind}:${entry.name}`;
      const projectId = config.pipelineProjects[pipelineId] ?? null;
      if (
        projectId === null
          ? context !== "Global"
          : !projectActionInScope(context, config, projectId)
      )
        return [];
      return [{ pipelineId, kind: entry.kind, name: entry.name, active: entry.active, projectId }];
    });
  });
  const definition = Effect.fn("D4AgentPipelines.definition")(function* (
    pipelineId: string,
    projectId: ProjectId,
    context: D4BrainContext,
  ) {
    const config = (yield* settings.getSettings.pipe(Effect.mapError(unavailable))).d4Agent;
    if (!projectActionInScope(context, config, projectId)) return yield* scopeError();
    const available = (yield* list(context)).find((entry) => entry.pipelineId === pipelineId);
    if (
      available === undefined ||
      (available.projectId !== null && available.projectId !== projectId)
    )
      return yield* scopeError();
    return yield* catalog.get(available.kind, available.name).pipe(Effect.mapError(unavailable));
  });
  const prepare = Effect.fn("D4AgentPipelines.prepare")(function* (
    action: PipelineAction,
    context: D4BrainContext,
  ) {
    const pipeline = yield* definition(action.pipelineId, action.projectId, context);
    if (
      (action.type === "research" && pipeline.kind !== "research") ||
      pipeline.pipelinePrompt.trim().length === 0 ||
      action.text.trim().length === 0
    )
      return yield* unavailable();
    return {
      pipelineId: action.pipelineId,
      projectId: action.projectId,
      modelSelection: action.modelSelection,
      text: `${pipeline.trigger}\n\n${action.text}`,
      pipelinePrompt: pipeline.pipelinePrompt,
      promptFiles: pipeline.promptFiles,
      scenarioHash: Catalog.pipelineFingerprint(pipeline),
    };
  });
  const execute = Effect.fn("D4AgentPipelines.execute")(function* (input: {
    readonly actionId: string;
    readonly context: D4BrainContext;
    readonly prepared: PreparedPipeline;
    readonly onCreated?: (threadId: ThreadId) => Effect.Effect<void, D4AgentError>;
  }) {
    const prepared = input.prepared;
    const pipeline = yield* definition(prepared.pipelineId, prepared.projectId, input.context);
    if (
      Catalog.pipelineFingerprint(pipeline) !== prepared.scenarioHash ||
      !prepared.text.startsWith(`${pipeline.trigger}\n\n`)
    )
      return yield* unavailable();
    const threadId = ThreadId.make(`d4-action:${input.actionId}`);
    yield* threads
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`d4-action-create:${input.actionId}`),
        threadId,
        projectId: prepared.projectId,
        title: pipeline.name,
        modelSelection: prepared.modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(Effect.mapError(unavailable));
    if (input.onCreated) yield* input.onCreated(threadId);
    yield* threads
      .sendToThread({
        projectId: prepared.projectId,
        threadId,
        commandId: CommandId.make(`d4-action:${input.actionId}`),
        messageId: MessageId.make(`d4-action:${input.actionId}`),
        text: prepared.text,
        attachments: [],
        mode: "queue",
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(Effect.mapError(unavailable));
    return threadId;
  });
  return D4AgentPipelines.of({ list, prepare, execute });
});
export const layer = Layer.effect(D4AgentPipelines, make).pipe(Layer.provide(Catalog.layer));
