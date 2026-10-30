import {
  CommandId,
  ThreadWorkspaceError,
  ThreadWorkspaceInspectInput,
  ThreadWorkspaceInspectResult,
  ThreadWorkspaceSelectInput,
  ThreadWorkspaceCreateInput,
  ThreadWorkspaceResult,
  type VcsListRefsResult,
} from "@d4research/contracts";
import {
  PRIMARY_WORKSPACE_BUSY_MESSAGE,
  resolveThreadWorkspaces,
  threadHasWorkspaceBoundWork,
} from "@d4research/shared/threadWorkspaces";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpProviderSessions from "@d4research/provider-core/server/McpProviderSessions";

// MCP supplies its session id so a replaced agent cannot attach a prepared checkout.
type Guard = { readonly providerSessionId?: string };
export class ThreadWorkspaces extends Context.Service<
  ThreadWorkspaces,
  {
    readonly inspect: (
      input: typeof ThreadWorkspaceInspectInput.Type & Guard,
    ) => Effect.Effect<typeof ThreadWorkspaceInspectResult.Type, ThreadWorkspaceError>;
    readonly select: (
      input: typeof ThreadWorkspaceSelectInput.Type & Guard,
    ) => Effect.Effect<typeof ThreadWorkspaceResult.Type, ThreadWorkspaceError>;
    readonly create: (
      input: typeof ThreadWorkspaceCreateInput.Type & Guard,
    ) => Effect.Effect<typeof ThreadWorkspaceResult.Type, ThreadWorkspaceError>;
  }
>()("d4research/workspace/ThreadWorkspaces") {}

const isThreadWorkspaceError = Schema.is(ThreadWorkspaceError);

const make = Effect.gen(function* () {
  const git = yield* GitWorkflowService;
  const engine = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const mutations = yield* Semaphore.make(1);
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const fail = (message: string) => Effect.fail(new ThreadWorkspaceError({ message }));
  const wrap = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isThreadWorkspaceError(cause)
          ? cause
          : new ThreadWorkspaceError({
              message: cause instanceof Error ? cause.message : String(cause),
            }),
      ),
    );
  const checkSession = Effect.fn("ThreadWorkspaces.checkSession")(function* (
    input: typeof ThreadWorkspaceInspectInput.Type & Guard,
  ) {
    if (
      input.providerSessionId !== undefined &&
      (yield* mcpSessions.read(input.threadId))?.providerSessionId !== input.providerSessionId
    ) {
      return yield* fail(
        "This MCP session is no longer active. Retry from the current provider session.",
      );
    }
  });
  const context = Effect.fn("ThreadWorkspaces.context")(function* (
    input: typeof ThreadWorkspaceInspectInput.Type & Guard,
  ) {
    yield* checkSession(input);
    const thread = yield* engine.getThreadShell(input.threadId);
    if (thread === null) return yield* fail("Thread not found.");
    const project = yield* projects.getById(thread.projectId);
    if (Option.isNone(project)) return yield* fail("Project not found.");
    const workspaces = resolveThreadWorkspaces(project.value, thread);
    const workspace = workspaces.find(
      (root) =>
        path.resolve(root.workspaceRoot) ===
        path.resolve(input.workspaceRoot ?? project.value.workspaceRoot),
    );
    if (!workspace)
      return yield* fail(
        "Unknown project directory. Inspect without workspaceRoot to list the configured repositories.",
      );
    return {
      input,
      thread,
      project: project.value,
      workspace,
      workspaces,
      cwd: workspace.path,
      root: workspace.workspaceRoot,
    };
  });
  type WorkspaceContext = Effect.Success<ReturnType<typeof context>>;
  const requirePrimaryIdle = (ctx: WorkspaceContext) =>
    ctx.workspace.primary && threadHasWorkspaceBoundWork(ctx.thread)
      ? fail(PRIMARY_WORKSPACE_BUSY_MESSAGE)
      : Effect.void;
  const attach = Effect.fn("ThreadWorkspaces.attach")(function* (
    ctx: WorkspaceContext,
    cwd: string,
  ) {
    yield* checkSession(ctx.input);
    const current = yield* engine.getThreadShell(ctx.thread.id);
    if (current === null) return yield* fail("Thread not found.");
    if (
      ctx.workspace.primary &&
      path.resolve(cwd) !== path.resolve(ctx.cwd) &&
      threadHasWorkspaceBoundWork(current)
    ) {
      return yield* fail(PRIMARY_WORKSPACE_BUSY_MESSAGE);
    }
    const currentWorkspace = resolveThreadWorkspaces(ctx.project, current).find(
      (root) => root.workspaceRoot === ctx.root,
    );
    if (
      !currentWorkspace ||
      currentWorkspace.path !== ctx.cwd ||
      currentWorkspace.branch !== ctx.workspace.branch
    ) {
      return yield* fail(
        `Thread selection changed while preparing ${cwd}. The checkout was kept; inspect again before selecting it.`,
      );
    }
    const status = yield* git.localStatus({ cwd });
    if (!status.isRepo) return yield* fail("The selected checkout is not a repository.");
    yield* engine.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(
        `server:workspace:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
      ),
      threadId: ctx.thread.id,
      ...(ctx.workspace.primary
        ? {
            expectedWorktreePath: ctx.thread.worktreePath,
            branch: status.refName,
            worktreePath: path.resolve(cwd) === path.resolve(ctx.root) ? null : cwd,
          }
        : {
            workspaceSelection: { workspaceRoot: ctx.root, cwd, branch: status.refName },
            expectedWorkspaceCwd: ctx.cwd,
          }),
    });
    yield* git.invalidateStatus(cwd);
    return {
      workspaceRoot: ctx.root,
      cwd,
      branch: status.refName,
      primary: ctx.workspace.primary,
      instructions: ctx.workspace.primary
        ? "T3 Code now selects this checkout for this thread. Changing the primary checkout detaches the current provider session. Continue in this cwd on the next turn; use t3_worktree_handoff when creating a primary worktree with an automatic continuation. Existing terminals and other threads are unchanged. No uncommitted files were moved and no setup script was run."
        : "T3 Code now selects this checkout for this repository in this thread's Files view. The primary repository and provider's default cwd are unchanged. Use this absolute cwd for every command and file operation in this repository. Other threads are unchanged. No uncommitted files were moved and no setup script was run.",
    };
  });
  return ThreadWorkspaces.of({
    inspect: Effect.fn("ThreadWorkspaces.inspect")((input) =>
      wrap(
        Effect.gen(function* () {
          const ctx = yield* context(input);
          return {
            projectRoot: ctx.project.workspaceRoot,
            workspaceRoot: ctx.root,
            cwd: ctx.cwd,
            workspaces: ctx.workspaces.map((root) => ({
              workspaceRoot: root.workspaceRoot,
              cwd: root.path,
              branch: root.branch,
              primary: root.primary,
              ...(root.label === undefined ? {} : { label: root.label }),
            })),
            status: yield* git.localStatus({ cwd: ctx.cwd }),
            refs: yield* git.listRefs({
              cwd: ctx.root,
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            }),
          };
        }),
      ),
    ),
    create: Effect.fn("ThreadWorkspaces.create")((input) =>
      wrap(
        mutations.withPermit(
          Effect.gen(function* () {
            const ctx = yield* context(input);
            // Reject before creating a worktree: this tool must not terminate its own caller.
            yield* requirePrimaryIdle(ctx);
            const cwd = (yield* git.createWorktree({
              cwd: ctx.cwd,
              refName: input.baseRef ?? "HEAD",
              newRefName: input.branch,
              path: null,
            })).worktree.path;
            return yield* attach(ctx, cwd);
          }),
        ),
      ),
    ),
    select: Effect.fn("ThreadWorkspaces.select")((input) =>
      wrap(
        mutations.withPermit(
          Effect.gen(function* () {
            const ctx = yield* context(input);
            if ((input.path === undefined) === (input.branch === undefined))
              return yield* fail("Provide exactly one of path or branch.");
            const alreadySelected =
              input.path !== undefined
                ? path.resolve(input.path) === path.resolve(ctx.cwd)
                : input.branch === ctx.workspace.branch;
            if (!alreadySelected) yield* requirePrimaryIdle(ctx);
            const refs: Array<VcsListRefsResult["refs"][number]> = [];
            let cursor: number | undefined;
            do {
              const page = yield* git.listRefs({
                cwd: ctx.root,
                ...(cursor === undefined ? {} : { cursor }),
              });
              refs.push(...page.refs);
              cursor = page.nextCursor ?? undefined;
            } while (cursor !== undefined);
            if (input.branch !== undefined) {
              const ref = refs.find((ref) => ref.name === input.branch);
              if (!ref) return yield* fail("Unknown branch. Inspect available refs first.");
              if (ref.worktreePath === null) yield* requirePrimaryIdle(ctx);
              const cwd =
                ref.worktreePath ??
                (yield* git.createWorktree({ cwd: ctx.root, refName: ref.name, path: null }))
                  .worktree.path;
              return yield* attach(ctx, cwd);
            }
            const allowed = [
              ctx.root,
              ctx.cwd,
              ...refs.flatMap((ref) => (ref.worktreePath ? [ref.worktreePath] : [])),
            ];
            const requestedPath = input.path;
            if (requestedPath === undefined) return yield* fail("Provide a checkout path.");
            const cwd = allowed.find(
              (candidate) => path.resolve(candidate) === path.resolve(requestedPath),
            );
            if (!cwd)
              return yield* fail(
                "Path is not a checkout of this thread's project directory. Inspect available checkouts first.",
              );
            return yield* attach(ctx, cwd);
          }),
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(ThreadWorkspaces, make);
