import { assert, it } from "@effect/vitest";
import {
  D4AgentError,
  ProjectId,
  ThreadId,
  RunId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadProjection,
} from "@d4research/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as Lifecycle from "./D4AgentThreadLifecycle.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";

const threadId = ThreadId.make("d4-action:task");
const projectId = ProjectId.make("project");
const runId = RunId.make("run");
const record: Lifecycle.AgentStartedThread = {
  threadId,
  projectId,
  context: "YB",
  actionId: "task",
  reportedAt: "1970-01-01T00:00:00.000Z",
  archivedAt: null,
  undoDisabled: false,
};
const shell = {
  id: threadId,
  projectId,
  createdBy: "agent",
  deletedAt: null,
  archivedAt: null,
  pinnedAt: null,
  activeRunId: null,
  latestRunId: runId,
  latestUserAuthoredMessageAt: null,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  hasActionableProposedPlan: false,
  updatedAt: DateTime.makeUnsafe(0),
} as unknown as OrchestrationV2ThreadShell;
const projection = {
  runs: [{ id: runId, status: "completed", completedAt: DateTime.makeUnsafe(0) }],
  runtimeRequests: [],
  messages: [{ role: "user", createdBy: "agent" }],
  subagents: [],
} as unknown as OrchestrationV2ThreadProjection;
const fixture = (
  shellPatch: Partial<OrchestrationV2ThreadShell> = {},
  projectionPatch: Partial<OrchestrationV2ThreadProjection> = {},
  metadataChangesBeforeArchive = false,
) => {
  let current = { ...shell, ...shellPatch };
  const rejectedCommands = new Set<string>();
  const dispatch = vi.fn(
    (command: Parameters<Threads.ThreadManagementService["Service"]["dispatch"]>[0]) =>
      Effect.gen(function* () {
        if (metadataChangesBeforeArchive) {
          current = { ...current, updatedAt: DateTime.makeUnsafe(1) };
          metadataChangesBeforeArchive = false;
        }
        if (
          rejectedCommands.has(command.commandId) ||
          (command.type === "thread.archive" &&
            command.onlyIfUpdatedAt !== DateTime.formatIso(current.updatedAt))
        ) {
          rejectedCommands.add(command.commandId);
          return yield* new D4AgentError({ reason: "thread" });
        }
        current = {
          ...current,
          archivedAt: command.type === "thread.archive" ? DateTime.makeUnsafe(86_400_000) : null,
        };
      }),
  );
  const services = Layer.mergeAll(
    Layer.succeed(Threads.ThreadManagementService, {
      getThreadShell: () => Effect.sync(() => current),
      dispatch,
    } as unknown as Threads.ThreadManagementService["Service"]),
    Layer.succeed(Projections.ProjectionStoreV2, {
      getThreadProjection: () => Effect.succeed({ ...projection, ...projectionPatch }),
    } as unknown as Projections.ProjectionStoreV2["Service"]),
  );
  return { dispatch, layer: Lifecycle.layer.pipe(Layer.provide(services)) };
};

it.effect("retries a stale archive with a new receipt after the thread version changes", () =>
  Effect.gen(function* () {
    const f = fixture({}, {}, true);
    yield* TestClock.adjust("24 hours");
    yield* Effect.gen(function* () {
      const service = yield* Lifecycle.D4AgentThreadLifecycle;
      assert.equal((yield* Effect.result(service.archive(record, 24)))._tag, "Failure");
      assert.isTrue(yield* service.archive(record, 24));
      assert.notEqual(
        f.dispatch.mock.calls[0]?.[0].commandId,
        f.dispatch.mock.calls[1]?.[0].commandId,
      );
      assert.deepInclude(f.dispatch.mock.calls[1]?.[0], {
        type: "thread.archive",
        onlyIfUpdatedAt: "1970-01-01T00:00:00.001Z",
      });
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect(
  "archives only after reporting and the full delay, using reversible archive and undo",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      yield* Effect.gen(function* () {
        const service = yield* Lifecycle.D4AgentThreadLifecycle;
        assert.isFalse(yield* service.archive(record, 24));
        yield* TestClock.adjust("24 hours");
        assert.isFalse(yield* service.archive({ ...record, reportedAt: null }, 24));
        assert.isFalse(yield* service.archive(record, null));
        assert.isTrue(yield* service.archive(record, 24));
        assert.deepInclude(f.dispatch.mock.calls[0]?.[0], {
          type: "thread.archive",
          onlyIfUpdatedAt: "1970-01-01T00:00:00.000Z",
        });
        yield* service.undo({ ...record, archivedAt: "1970-01-02T00:00:00.000Z" });
        assert.equal(f.dispatch.mock.calls[1]?.[0].type, "thread.unarchive");
        assert.isFalse(yield* service.archive({ ...record, undoDisabled: true }, 24));
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect.each([
  ["user-owned", { createdBy: "user" }],
  ["pinned", { pinnedAt: DateTime.makeUnsafe(0) }],
  ["user reply", { latestUserAuthoredMessageAt: DateTime.makeUnsafe(0) }],
  ["active run", { activeRunId: runId }],
  ["pending request", { pendingRuntimeRequest: { id: "request" } }],
  ["pending work", { pendingBackgroundTasks: [{ id: "pending" }] }],
] as const)("never archives %s threads", ([_label, patch]) =>
  Effect.gen(function* () {
    const f = fixture(patch as Partial<OrchestrationV2ThreadShell>);
    yield* TestClock.adjust("24 hours");
    yield* Effect.gen(function* () {
      const service = yield* Lifecycle.D4AgentThreadLifecycle;
      assert.isFalse(yield* service.archive(record, 24));
      assert.equal(f.dispatch.mock.calls.length, 0);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect(
  "checks historical user replies and refuses reports from before the latest completion",
  () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("24 hours");
      for (const patch of [
        { messages: [{ role: "user", createdBy: "user" }] },
        { runs: [{ id: runId, status: "completed", completedAt: DateTime.makeUnsafe(1000) }] },
        { runs: [{ id: runId, status: "failed", completedAt: DateTime.makeUnsafe(0) }] },
        {
          runs: [
            ...projection.runs,
            { id: RunId.make("queued"), status: "queued", completedAt: null },
          ],
        },
      ]) {
        const f = fixture({}, patch as Partial<OrchestrationV2ThreadProjection>);
        yield* Effect.gen(function* () {
          assert.isFalse(yield* (yield* Lifecycle.D4AgentThreadLifecycle).archive(record, 24));
          assert.equal(f.dispatch.mock.calls.length, 0);
        }).pipe(Effect.provide(f.layer));
      }
    }),
);
