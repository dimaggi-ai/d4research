import { OrchestratorMcpFailure } from "@d4research/contracts";
import * as McpToolAccess from "../McpToolAccess.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import {
  ThreadWorkspaceError,
  ThreadWorkspaceInspectInput,
  ThreadWorkspaceInspectResult,
  ThreadWorkspaceSelectInput,
  ThreadWorkspaceCreateInput,
  ThreadWorkspaceResult,
} from "@d4research/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as Effect from "effect/Effect";
import { Tool, Toolkit } from "effect/ai";
import {
  McpInvocationContext,
  requireMcpCapability,
  requireThreadScope,
} from "../McpInvocationContext.ts";
import * as ThreadWorkspaces from "../../workspace/ThreadWorkspaces.ts";

const dependencies = [McpInvocationContext, ThreadManagementService.ThreadManagementService];
const inspect = Tool.make("thread_workspace_inspect", {
  description:
    "Inspect this thread's selected checkout, all project directories and their chosen checkouts, local changes, branches/worktrees. Set workspaceRoot to a configured repository root; omit it for the primary. Follow refs.nextCursor to list more refs. Does not change anything.",
  parameters: ThreadWorkspaceInspectInput.mapFields(Struct.omit(["threadId"])),
  success: ThreadWorkspaceInspectResult,
  failure: Schema.Union([ThreadWorkspaceError, OrchestratorMcpFailure]),
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);
const create = Tool.make("thread_workspace_create", {
  description:
    "Create and SELECT a new worktree for an additional repository in this thread. Set workspaceRoot explicitly for that repository. Call BEFORE editing so T3's Files selectors follow your work. The primary checkout can only change when the thread has no active or background work; attempting to move your own running session is rejected without creating a worktree. From the project root use t3_worktree_handoff with continuationPrompt for an explicit primary handoff, or t3_thread_launch with workspaceStrategy for a separate thread. Uncommitted files are not transferred; run setup yourself. Use the returned cwd explicitly in running tools.",
  parameters: ThreadWorkspaceCreateInput.mapFields(Struct.omit(["threadId"])),
  success: ThreadWorkspaceResult,
  failure: Schema.Union([ThreadWorkspaceError, OrchestratorMcpFailure]),
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
const select = Tool.make("thread_workspace_select", {
  description:
    "SELECT an existing checkout for one repository in this thread and update its Files selector. Set workspaceRoot for an additional repository, omit it for the primary. Additional repositories can change while you work; the primary checkout is pinned while any turn, question or background work is active, so do not use this tool to move your own running session. Selecting its current checkout is harmless. Provide path from inspect or a branch name (creates a safe linked worktree if necessary). Select each additional repository BEFORE editing. For other primary work, use its absolute cwd or t3_thread_launch with an existing_worktree workspaceStrategy. No forced checkout, deletion or moving uncommitted files. Use returned cwd explicitly.",
  parameters: ThreadWorkspaceSelectInput.mapFields(Struct.omit(["threadId"])),
  success: ThreadWorkspaceResult,
  failure: Schema.Union([ThreadWorkspaceError, OrchestratorMcpFailure]),
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);
export const WorkspaceToolkit = Toolkit.make(inspect, create, select);

export const WorkspaceHandlersLive = McpToolAccess.toLayer(
  WorkspaceToolkit,
  Effect.gen(function* () {
    const workspaces = yield* ThreadWorkspaces.ThreadWorkspaces;
    const scope = requireMcpCapability("workspace").pipe(
      Effect.flatMap((scope) => requireThreadScope(scope, "thread workspace selection")),
      Effect.mapError((cause) => new ThreadWorkspaceError({ message: cause.message })),
    );
    return {
      thread_workspace_inspect: McpToolAccess.readsAsCaller((input) =>
        Effect.flatMap(scope, (ctx) =>
          workspaces.inspect({
            ...input,
            threadId: ctx.thread.threadId,
            providerSessionId: ctx.thread.providerSessionId,
          }),
        ),
      ),
      thread_workspace_create: McpToolAccess.actsAsCaller((input) =>
        Effect.flatMap(scope, (ctx) =>
          workspaces.create({
            ...input,
            threadId: ctx.thread.threadId,
            providerSessionId: ctx.thread.providerSessionId,
          }),
        ),
      ),
      thread_workspace_select: McpToolAccess.actsAsCaller((input) =>
        Effect.flatMap(scope, (ctx) =>
          workspaces.select({
            ...input,
            threadId: ctx.thread.threadId,
            providerSessionId: ctx.thread.providerSessionId,
          }),
        ),
      ),
    };
  }),
);
