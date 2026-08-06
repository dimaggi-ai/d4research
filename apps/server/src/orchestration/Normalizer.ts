import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  type ClientOrchestrationCommand,
  type IsoDateTime,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  type ProjectId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { expandSkillTokens, findSkillTokens } from "../skillExpansion.ts";
import { readSkillsInventory, type SkillsInventoryRoot } from "../skillsInventory.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

/**
 * Every root takes part in expansion. Project skills need the thread's
 * workspace, which is resolved below; when that lookup comes up empty the
 * inventory simply holds no project rows.
 */
const EXPANDABLE_SKILL_ROOTS: ReadonlySet<SkillsInventoryRoot> = new Set<SkillsInventoryRoot>([
  "claude-user",
  "codex-user",
  "junie-user",
  "project",
]);

/**
 * Skill names the target provider instance already resolves on its own. With
 * no registry in context (and none is required — the Normalizer runs in tests
 * without one) nothing is treated as native.
 */
const resolveNativeSkillNames = Effect.fn("normalizer.resolveNativeSkillNames")(function* (
  instanceId: ProviderInstanceId | undefined,
) {
  if (instanceId === undefined) {
    return [] as ReadonlyArray<string>;
  }
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  if (Option.isNone(registry)) {
    return [] as ReadonlyArray<string>;
  }
  const providers = yield* registry.value.getProviders;
  const snapshot = providers.find((provider) => provider.instanceId === instanceId);
  return (snapshot?.skills ?? []).map((skill) => skill.name);
});

/**
 * The workspace a thread's project-scoped skills live under. A brand-new
 * thread carries its workspace root on the bootstrap; an existing one is
 * looked up through the read model. Optional service, so a caller without
 * projections (and the Normalizer's own tests) simply loses project skills
 * rather than failing the turn.
 */
const resolveThreadSkillsCwd = Effect.fn("normalizer.resolveThreadSkillsCwd")(function* (
  threadId: ThreadId,
  bootstrap: {
    readonly workspaceRoot: string | undefined;
    readonly projectId: ProjectId | undefined;
  },
) {
  if (bootstrap.workspaceRoot) {
    return bootstrap.workspaceRoot;
  }
  const query = yield* Effect.serviceOption(ProjectionSnapshotQuery);
  if (Option.isNone(query)) {
    return undefined;
  }
  // A thread being created in this same command has no read-model row yet;
  // its project does.
  if (bootstrap.projectId) {
    const project = yield* query.value.getProjectShellById(bootstrap.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );
    return project?.workspaceRoot;
  }
  const thread = yield* query.value.getThreadDetailById(threadId).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  if (!thread) {
    return undefined;
  }
  const project = yield* query.value.getProjectShellById(thread.projectId).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  return resolveThreadWorkspaceCwd({ thread, projects: project ? [project] : [] });
});

/**
 * Append a compact skill reference block for `$name` attachments the target
 * provider cannot resolve itself. The expansion is part of the persisted user
 * message, so the visible thread stays authoritative on every client.
 *
 * Best effort throughout: a message with no `$` never touches the filesystem,
 * and any failure sends the text unchanged rather than failing the turn.
 */
const expandSkillReferences = Effect.fn("normalizer.expandSkillReferences")(function* (input: {
  readonly text: string;
  readonly instanceId: ProviderInstanceId | undefined;
  readonly threadId: ThreadId;
  readonly bootstrap: {
    readonly workspaceRoot: string | undefined;
    readonly projectId: ProjectId | undefined;
  };
}) {
  if (!input.text.includes("$") || findSkillTokens(input.text).length === 0) {
    return input.text;
  }

  return yield* Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tokenNames = new Set(findSkillTokens(input.text).map((token) => token.name));
    const cwd = yield* resolveThreadSkillsCwd(input.threadId, input.bootstrap);
    const inventory = yield* readSkillsInventory(cwd === undefined ? {} : { cwd });
    const candidates = inventory.filter(
      (entry) => EXPANDABLE_SKILL_ROOTS.has(entry.root) && tokenNames.has(entry.name),
    );
    if (candidates.length === 0) {
      return input.text;
    }

    const nativeSkillNames = yield* resolveNativeSkillNames(input.instanceId);
    const workspaceSkills = yield* Effect.forEach(candidates, (entry) =>
      fileSystem.exists(entry.path).pipe(
        Effect.orElseSucceed(() => false),
        Effect.map((available) => ({
          name: entry.name,
          path: entry.path,
          available,
          ...(entry.description ? { description: entry.description } : {}),
        })),
      ),
    );

    return expandSkillTokens({ text: input.text, workspaceSkills, nativeSkillNames }).text;
  }).pipe(Effect.catchCause(() => Effect.succeed(input.text)));
});

export const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: IsoDateTime,
): ClientOrchestrationCommand => {
  const canonicalCommand =
    "createdAt" in command
      ? {
          ...command,
          createdAt: receivedAt,
        }
      : command;

  if (canonicalCommand.type !== "thread.turn.start" || !canonicalCommand.bootstrap?.createThread) {
    return canonicalCommand;
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      createThread: {
        ...canonicalCommand.bootstrap.createThread,
        createdAt: receivedAt,
      },
    },
  };
};

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    if (canonicalCommand.type === "project.create") {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          canonicalCommand.workspaceRoot,
          canonicalCommand.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.meta.update" &&
      canonicalCommand.workspaceRoot !== undefined
    ) {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(canonicalCommand.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (canonicalCommand.type !== "thread.turn.start") {
      return canonicalCommand as OrchestrationCommand;
    }

    const normalizedAttachments = yield* Effect.forEach(
      canonicalCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(canonicalCommand.threadId);
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    const text = yield* expandSkillReferences({
      text: canonicalCommand.message.text,
      instanceId:
        canonicalCommand.modelSelection?.instanceId ??
        canonicalCommand.bootstrap?.createThread?.modelSelection?.instanceId,
      threadId: canonicalCommand.threadId,
      bootstrap: {
        workspaceRoot:
          canonicalCommand.bootstrap?.createThread?.worktreePath ??
          canonicalCommand.bootstrap?.prepareWorktree?.projectCwd,
        projectId: canonicalCommand.bootstrap?.createThread?.projectId,
      },
    });

    return {
      ...canonicalCommand,
      message: {
        ...canonicalCommand.message,
        text,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });
