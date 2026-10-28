import {
  DEFAULT_D4_AGENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
} from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type * as D4AgentStore from "../d4Agent/D4AgentStore.ts";
import { pipelineFingerprint } from "../d4Agent/PipelineCatalog.ts";
import { taskScopeHash } from "../d4Agent/brainScope.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { PIPELINE_RESUME_PROMPT, resumePipelineRun } from "./PipelineRunResume.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";

const projectId = ProjectId.make("dimaggi");
const threadId = ThreadId.make("d4-action:audit");
const scenario = {
  kind: "research" as const,
  name: "default",
  pipelinePrompt: "Edited after approval",
  promptFiles: [],
};
const d4Agent = {
  ...DEFAULT_D4_AGENT_SETTINGS,
  pipelineProjects: { "research:default": projectId },
};
const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  d4Agent,
  research: { ...DEFAULT_SERVER_SETTINGS.research, scenarios: [scenario] },
};
const scopeRecord = {
  threadId,
  projectId,
  context: "Global" as const,
  actionId: "audit",
  reportedAt: null,
  archivedAt: null,
  undoDisabled: false,
  scopeHash: taskScopeHash("Global", d4Agent, projectId, "research:default"),
  pipelineId: "research:default",
  pipelineHash: pipelineFingerprint({ ...scenario, pipelinePrompt: "As approved" }),
};

const harness = (runs: ReadonlyArray<{ id: string; ordinal: number; status: string }>) =>
  Effect.gen(function* () {
    const sent = yield* Ref.make<ReadonlyArray<{ commandId: string; text: string }>>([]);
    const dispatched = yield* Ref.make<ReadonlyArray<string>>([]);
    const state = yield* Ref.make({
      taskScopes: [scopeRecord],
    } as unknown as D4AgentStore.StoredState);
    const store = {
      get: Ref.get(state),
      update: (change: (current: D4AgentStore.StoredState) => D4AgentStore.StoredState) =>
        Ref.update(state, change),
    } as unknown as D4AgentStore.D4AgentStore["Service"];
    const layer = Layer.mergeAll(
      Layer.mock(ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed({ projectId, archivedAt: "2026-10-27T17:00:00Z" } as never),
        dispatch: (command: { type: string }) =>
          Ref.update(dispatched, (all) => [...all, command.type]).pipe(Effect.as({} as never)),
        sendToThread: (input: { commandId: string; text: string }) =>
          Ref.update(sent, (all) => [...all, input]).pipe(
            Effect.as({ run: { id: "run-resume" } } as never),
          ),
      }),
      Layer.mock(ProjectionStoreV2)({
        getThreadRecords: () =>
          Effect.succeed({
            runs: runs.map((run) => ({
              ...run,
              startedAt: "2026-10-27T16:00:00Z",
              userMessageId: `m-${run.id}`,
            })),
            messages: [{ id: "m-run-1", role: "user", text: "!research:default Audit" }],
          } as never),
      }),
      Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(settings) }),
    );
    const resume = resumePipelineRun({
      threadId,
      createdBy: "user",
      creationSource: "web",
      store,
    }).pipe(Effect.provide(layer));
    return { resume, sent, dispatched, state };
  });

describe("resumePipelineRun", () => {
  it("re-pins an edited pipeline, restores the thread, and sends one keyed resume", async () => {
    await Effect.gen(function* () {
      const test = yield* harness([{ id: "run-1", ordinal: 1, status: "cancelled" }]);
      const result = yield* test.resume;
      expect(result).toEqual({ threadId, runId: "run-resume", repinnedPipeline: true });
      expect(yield* Ref.get(test.dispatched)).toEqual(["thread.unarchive"]);
      expect(yield* Ref.get(test.sent)).toMatchObject([
        { commandId: "pipeline-resume:run-1", text: PIPELINE_RESUME_PROMPT },
      ]);
      const repinned = (yield* Ref.get(test.state)).taskScopes?.[0]?.pipelineHash;
      expect(repinned).toBe(pipelineFingerprint(scenario));
    }).pipe(Effect.runPromise);
  });

  it("refuses while a run is active and when nothing was interrupted", async () => {
    await Effect.gen(function* () {
      const busy = yield* harness([
        { id: "run-1", ordinal: 1, status: "cancelled" },
        { id: "run-2", ordinal: 2, status: "starting" },
      ]);
      expect(yield* Effect.flip(busy.resume)).toMatchObject({ reason: "busy" });
      const done = yield* harness([{ id: "run-1", ordinal: 1, status: "completed" }]);
      expect(yield* Effect.flip(done.resume)).toMatchObject({ reason: "not-resumable" });
      expect(yield* Ref.get(done.sent)).toEqual([]);
    }).pipe(Effect.runPromise);
  });
});
