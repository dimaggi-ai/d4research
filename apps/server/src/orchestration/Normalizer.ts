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
} from "@d4research/contracts";
import {
  appendEnabledSkillsContext,
  mergeEnabledSkillNames,
} from "@d4research/shared/enabledSkillsContext";

import {
  createAttachmentId,
  planAttachmentClaim,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
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
  "agy-user",
  "project",
]);

const DEFAULT_SKILL_ROOT_PRIORITY: Readonly<Record<SkillsInventoryRoot, number>> = {
  // A project skill intentionally shadows a user skill with the same name.
  project: 0,
  "codex-user": 1,
  "claude-user": 2,
  "junie-user": 3,
  "agy-user": 4,
};

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

/**
 * Resolve the user's always-on names against the live inventory and attach
 * compact file references. Settings and filesystem failures are deliberately
 * best effort: they must never block an otherwise valid turn.
 */
const appendEnabledSkillReferences = Effect.fn("normalizer.appendEnabledSkillReferences")(
  function* (input: {
    readonly text: string;
    readonly threadId: ThreadId;
    readonly bootstrap: {
      readonly workspaceRoot: string | undefined;
      readonly projectId: ProjectId | undefined;
    };
  }) {
    const settingsService = yield* Effect.serviceOption(ServerSettingsService);
    if (Option.isNone(settingsService)) return input.text;

    return yield* Effect.gen(function* () {
      const settings = yield* settingsService.value.getSettings;
      const globalNames = settings.skills.enabledByDefault;
      const sessionNames = settings.skills.enabledByThread[input.threadId] ?? [];
      const configuredNames = mergeEnabledSkillNames(globalNames, sessionNames);
      if (configuredNames.length === 0) return input.text;
      const globalNameSet = new Set(globalNames);

      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* resolveThreadSkillsCwd(input.threadId, input.bootstrap);
      const inventory = yield* readSkillsInventory(cwd === undefined ? {} : { cwd });
      const candidates = inventory
        .filter((entry) => entry.kind === "skill" && configuredNames.includes(entry.name))
        .sort(
          (left, right) =>
            DEFAULT_SKILL_ROOT_PRIORITY[left.root] - DEFAULT_SKILL_ROOT_PRIORITY[right.root],
        );

      const byName = new Map<string, (typeof candidates)[number]>();
      for (const entry of candidates) {
        if (!byName.has(entry.name)) byName.set(entry.name, entry);
      }
      const available = yield* Effect.forEach(configuredNames, (name) => {
        const entry = byName.get(name);
        if (!entry) return Effect.succeed(null);
        return fileSystem.exists(entry.path).pipe(
          Effect.orElseSucceed(() => false),
          Effect.map((exists) =>
            exists
              ? {
                  name: entry.name,
                  path: entry.path,
                  scope: globalNameSet.has(entry.name) ? ("global" as const) : ("session" as const),
                  ...(entry.description ? { description: entry.description } : {}),
                }
              : null,
          ),
        );
      });

      return appendEnabledSkillsContext(
        input.text,
        available.filter((skill) => skill !== null),
      );
    }).pipe(Effect.catchCause(() => Effect.succeed(input.text)));
  },
);

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

const removeClaimedAttachmentPaths = Effect.fn("Normalizer.removeClaimedAttachmentPaths")(
  function* (attachmentPaths: ReadonlyArray<string>) {
    if (attachmentPaths.length === 0) return;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(
      attachmentPaths,
      (attachmentPath) => fileSystem.remove(attachmentPath, { force: true }).pipe(Effect.ignore),
      { concurrency: 1 },
    );
  },
);

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

    const claimedAttachmentPaths: string[] = [];
    const normalizedAttachments = yield* Effect.forEach(
      canonicalCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (!("dataUrl" in attachment)) {
            const claim = planAttachmentClaim({
              attachmentsDir: serverConfig.attachmentsDir,
              threadId: canonicalCommand.threadId,
              attachmentId: attachment.id,
            });
            if (!claim.ok) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
              });
            }
            const info = yield* fileSystem.stat(claim.currentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationDispatchCommandError({
                    message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
                    cause,
                  }),
              ),
            );
            if (Number(info.size) !== attachment.sizeBytes) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: stored size does not match.`,
              });
            }
            const normalizedAttachment = {
              ...attachment,
              id: claim.finalId,
              mimeType: attachment.mimeType.toLowerCase(),
            };
            const expectedPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment: normalizedAttachment,
            });
            if (expectedPath !== claim.finalPath) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: attachment type does not match the upload.`,
              });
            }
            yield* fileSystem.copyFile(claim.currentPath, claim.finalPath).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationDispatchCommandError({
                    message: `Failed to claim attachment '${attachment.name}' for this thread.`,
                    cause,
                  }),
              ),
            );
            claimedAttachmentPaths.push(claim.finalPath);
            return normalizedAttachment;
          }

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
    ).pipe(Effect.tapError(() => removeClaimedAttachmentPaths(claimedAttachmentPaths)));

    const textWithExplicitSkills = yield* expandSkillReferences({
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
    const text = yield* appendEnabledSkillReferences({
      text: textWithExplicitSkills,
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

export const cleanupFailedUploadedAttachments = Effect.fn(
  "Normalizer.cleanupFailedUploadedAttachments",
)(function* (command: ClientOrchestrationCommand, normalizedCommand: OrchestrationCommand) {
  if (command.type !== "thread.turn.start" || normalizedCommand.type !== "thread.turn.start")
    return;
  const serverConfig = yield* ServerConfig;
  const claimedPaths: string[] = [];
  for (const [index, attachment] of normalizedCommand.message.attachments.entries()) {
    const original = command.message.attachments[index];
    if (
      !original ||
      "dataUrl" in original ||
      parseThreadSegmentFromAttachmentId(original.id) !== PENDING_ATTACHMENT_THREAD_SEGMENT
    ) {
      continue;
    }
    const claimedPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (claimedPath) claimedPaths.push(claimedPath);
  }
  yield* removeClaimedAttachmentPaths(claimedPaths);
});
