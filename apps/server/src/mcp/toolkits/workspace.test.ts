import * as McpToolAccess from "../McpToolAccess.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@d4research/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { ThreadManagementService } from "../../orchestration-v2/ThreadManagementService.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import * as ThreadWorkspaces from "../../workspace/ThreadWorkspaces.ts";
import * as DateTime from "effect/DateTime";
import { ServerSettingsService } from "../../serverSettings.ts";
import { McpInvocationContext, type McpCapability } from "../McpInvocationContext.ts";
import * as McpProviderSessions from "@d4research/provider-core/server/McpProviderSessions";
import { WorkspaceHandlersLive, WorkspaceToolkit } from "./workspace.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

const threadId = ThreadId.make("workspace-test");
const projectId = ProjectId.make("workspace-project");
const providerInstanceId = ProviderInstanceId.make("claude");
const makeHarness = Effect.fn("makeWorkspaceHarness")(function* (
  overrides: Partial<OrchestrationV2ThreadShell>,
) {
  const commands: Array<OrchestrationV2ServerCommand> = [];
  const creations: Array<unknown> = [];
  const captures: Array<string> = [];
  const now = "2026-09-13T00:00:00.000Z";
  let thread = shell({
    id: threadId,
    projectId,
    branch: "main",
    providerInstanceId,
    activeRunId: RunId.make("workspace-run"),
    modelSelection: { instanceId: providerInstanceId, model: "test" },
    ...overrides,
  });
  const scope = {
    environmentId: EnvironmentId.make("test"),
    threadId,
    providerSessionId: "session-test",
    providerInstanceId,
    issuedAt: 1,
  };
  const sessions = yield* McpProviderSessions.McpProviderSessions;
  yield* Effect.acquireRelease(
    sessions.set({
      ...scope,
      capabilities: new Set(["workspace"]),
      browserToolsAvailable: false,
      endpoint: "http://test",
      authorizationHeader: "test",
    }),
    () => sessions.clear(threadId),
  );
  const deps = Layer.mergeAll(
    Layer.succeed(McpProviderSessions.McpProviderSessions, sessions),
    Path.layer,
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(4),
        digest: (_, data) => Effect.succeed(data),
      }),
    ),
    Layer.mock(ServerSettingsService)({ getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS) }),
    Layer.mock(ProjectService)({
      getById: () =>
        Effect.succeedSome({
          id: projectId,
          title: "Project",
          workspaceRoot: "/repo",
          workspaceRoots: [{ path: "/repo" }, { path: "/backend", label: "Backend" }],
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        }),
    }),
    Layer.mock(ThreadManagementService)({
      getThreadShell: (id) => Effect.sync(() => (id === threadId ? thread : null)),
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.type === "thread.metadata.update") {
            thread = {
              ...thread,
              ...(command.branch === undefined ? {} : { branch: command.branch }),
              ...(command.worktreePath === undefined ? {} : { worktreePath: command.worktreePath }),
              ...(command.workspaceSelection === undefined
                ? {}
                : {
                    workspaceSelections: [
                      ...(thread.workspaceSelections ?? []).filter(
                        (root) => root.workspaceRoot !== command.workspaceSelection!.workspaceRoot,
                      ),
                      command.workspaceSelection,
                    ],
                  }),
            };
          }
          return { sequence: commands.length, storedEvents: [] };
        }),
    }),
    Layer.mock(GitWorkflowService)({
      localStatus: ({ cwd }) =>
        Effect.succeed({
          isRepo: !cwd.endsWith("/deleted"),
          hasPrimaryRemote: true,
          isDefaultRef: cwd === "/repo",
          refName: cwd === "/repo" ? "main" : "task",
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
        }),
      listRefs: ({ cursor, cwd }) =>
        Effect.succeed({
          isRepo: !cwd.endsWith("/deleted"),
          hasPrimaryRemote: true,
          totalCount: 2,
          nextCursor: cursor === undefined ? 1 : null,
          refs: cwd.endsWith("/deleted")
            ? []
            : [
                {
                  name: cursor === undefined ? "main" : "task",
                  current: cursor === undefined,
                  isDefault: cursor === undefined,
                  worktreePath:
                    cursor === undefined
                      ? cwd.startsWith("/backend")
                        ? "/backend"
                        : "/repo"
                      : cwd.startsWith("/backend")
                        ? "/backend/task"
                        : "/worktrees/task",
                },
              ],
        }),
      createWorktree: (input) =>
        Effect.sync(() => {
          creations.push(input);
          return {
            worktree: { path: "/worktrees/new", refName: input.newRefName ?? input.refName },
          };
        }),
      invalidateStatus: () => Effect.void,
    }),
  );
  const toolkit = yield* WorkspaceToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(WorkspaceHandlersLive).pipe(
        Layer.provide(ThreadWorkspaces.layer.pipe(Layer.provide(deps))),
      ),
    ),
  );
  const call = <Name extends keyof typeof WorkspaceToolkit.tools>(
    name: Name,
    input: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpCapability> = ["workspace"],
  ) =>
    toolkit.handle(name, input).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.flatMap((chunk) => {
        const output = chunk.at(-1)!;
        return output.isFailure
          ? Effect.fail(output.result as Tool.Failure<(typeof WorkspaceToolkit.tools)[Name]>)
          : Effect.succeed(output.result as Tool.Success<(typeof WorkspaceToolkit.tools)[Name]>);
      }),
      Effect.provideService(McpInvocationContext, {
        environmentId: scope.environmentId,
        issuedAt: scope.issuedAt,
        requestNamespace: scope.providerSessionId,
        client: undefined,
        thread: {
          threadId: scope.threadId,
          providerSessionId: scope.providerSessionId,
          providerInstanceId: scope.providerInstanceId,
        },
        capabilities: new Set(capabilities),
      }),
      Effect.provide(deps),
    );
  return { call, commands, creations, captures, clearSession: () => sessions.clear(threadId) };
}, Effect.provide(McpProviderSessions.layer));

describe("thread workspace MCP", () => {
  it.effect("recovers a missing primary checkout through a live sibling branch", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ worktreePath: "/worktrees/deleted", branch: "deleted" });
      const inspected = yield* h.call("thread_workspace_inspect", {});
      expect(inspected.status.isRepo).toBe(false);
      expect(inspected.refs.refs[0]?.name).toBe("main");
      const selected = yield* h.call("thread_workspace_select", { branch: "task" });
      expect(selected.cwd).toBe("/worktrees/task");
      expect(h.commands[0]).toMatchObject({
        worktreePath: "/worktrees/task",
        expectedWorktreePath: "/worktrees/deleted",
      });
      expect(h.creations).toEqual([]);
    }).pipe(Effect.scoped),
  );
  it.effect("recovers a missing secondary checkout without changing the primary", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        workspaceSelections: [
          { workspaceRoot: "/backend", cwd: "/backend/deleted", branch: "deleted" },
        ],
      });
      const selected = yield* h.call("thread_workspace_select", {
        workspaceRoot: "/backend",
        path: "/backend/task",
      });
      expect(selected.cwd).toBe("/backend/task");
      expect(h.commands[0]).toMatchObject({
        workspaceSelection: { workspaceRoot: "/backend", cwd: "/backend/task" },
        expectedWorkspaceCwd: "/backend/deleted",
      });
      expect(h.commands[0]).not.toHaveProperty("worktreePath");
    }).pipe(Effect.scoped),
  );
  it.effect("does not recover a missing primary checkout while work is active", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        worktreePath: "/worktrees/deleted",
        activityRunStatus: "running",
      });
      yield* h.call("thread_workspace_select", { path: "/repo" }).pipe(Effect.flip);
      expect(h.commands).toEqual([]);
      expect(h.creations).toEqual([]);
    }).pipe(Effect.scoped),
  );
  it.effect("selects each repository independently and preserves the primary checkout", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({});
      const selected = yield* h.call("thread_workspace_select", {
        workspaceRoot: "/backend",
        branch: "task",
      });
      expect(selected.primary).toBe(false);
      expect(h.commands[0]).toMatchObject({
        type: "thread.metadata.update",
        workspaceSelection: { workspaceRoot: "/backend", cwd: "/backend/task" },
        expectedWorkspaceCwd: "/backend",
      });
      expect(h.commands[0]).not.toHaveProperty("worktreePath");
      const inspect = yield* h.call("thread_workspace_inspect", { workspaceRoot: "/backend" });
      expect(inspect.cwd).toBe("/backend/task");
      expect(inspect.workspaces.find((root) => root.primary)?.cwd).toBe("/repo");
      yield* h.call("thread_workspace_select", { path: "/worktrees/task" });
      expect((yield* h.call("thread_workspace_inspect", { workspaceRoot: "/backend" })).cwd).toBe(
        "/backend/task",
      );
    }).pipe(Effect.scoped),
  );
  it.effect("rejects ambiguous selection without changes", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({});
      for (const input of [{}, { path: "/repo", branch: "main" }]) {
        const error = yield* h.call("thread_workspace_select", input).pipe(Effect.flip);
        expect(error.message).toContain("exactly one");
      }
      expect(h.commands).toEqual([]);
      expect(h.creations).toEqual([]);
    }).pipe(Effect.scoped),
  );
  it.effect("inspects without mutation and preserves ref pagination", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({});
      const result = yield* h.call("thread_workspace_inspect", {});
      expect(result.cwd).toBe("/repo");
      expect(result.refs.nextCursor).toBe(1);
      expect(h.commands).toEqual([]);
    }).pipe(Effect.scoped),
  );
  it.effect("creates from the requested base and selects only the token's thread", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({});
      const result = yield* h.call("thread_workspace_create", {
        mode: "worktree",
        branch: "task",
        baseRef: "release",
      });
      expect(h.creations).toEqual([
        { cwd: "/repo", refName: "release", newRefName: "task", path: null },
      ]);
      expect(h.commands[0]).toMatchObject({
        type: "thread.metadata.update",
        threadId,
        worktreePath: "/worktrees/new",
        branch: "task",
      });
      expect(result.instructions).toContain("detaches");
    }).pipe(Effect.scoped),
  );
  it.effect("selects older worktrees across ref pages and can return to the project root", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({});
      expect((yield* h.call("thread_workspace_select", { branch: "task" })).cwd).toBe(
        "/worktrees/task",
      );
      expect(h.creations).toEqual([]);
      yield* h.call("thread_workspace_select", { path: "/repo/" });
      expect(h.commands.at(-1)).toMatchObject({ worktreePath: null, branch: "main" });
    }).pipe(Effect.scoped),
  );
  it.effect("rejects unrelated directories without mutation", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({});
      const error = yield* h
        .call("thread_workspace_select", { path: "/unrelated/repo" })
        .pipe(Effect.flip);
      expect(error.message).toContain("not a checkout");
      expect(h.commands).toHaveLength(0);
    }).pipe(Effect.scoped),
  );
  it.effect("rejects missing capabilities and stale sessions before any mutation", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({});
      yield* h
        .call("thread_workspace_create", { mode: "worktree", branch: "task" }, [])
        .pipe(Effect.flip);
      yield* h.clearSession();
      const error = yield* h
        .call("thread_workspace_create", { mode: "worktree", branch: "task" })
        .pipe(Effect.flip);
      expect(error.message).toContain("no longer active");
      expect(h.commands).toEqual([]);
      expect(h.creations).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
