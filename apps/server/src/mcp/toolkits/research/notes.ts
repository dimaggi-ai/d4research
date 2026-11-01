// @effect-diagnostics effectFnOpportunity:warning -- d4research module predating the Effect.fn style rule.
import * as HostProcess from "@d4research/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off - Native no-follow file handles and exclusive publishing protect artifact boundaries.
import * as NodeFSP from "node:fs/promises";
import { NotesError, type ThreadId } from "@d4research/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import type { NotesListResult, NotesReadResult } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../../../orchestration-v2/ProjectStore.ts";
import { safeDirectory } from "./artifactFiles.ts";
import {
  entryBelongsToThread,
  readResearchLedger,
  readRunArtifact,
  resolveResearchRunDirectory,
} from "./runArtifacts.ts";

// The setting belongs to the destination environment. An environment variable
// supplies an install-local default, never a path baked into distributed code.
export const resolveNotesFolder = (configured: string): string =>
  configured.trim() || process.env.D4RESEARCH_NOTES_DIR?.trim() || "";
const contextFor = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStoreV2;
    const projects = yield* ProjectStoreV2;
    const settings = yield* ServerSettingsService;
    const thread = yield* projections.getThread(threadId);
    const project = yield* projects.getShell(thread.projectId);
    if (Option.isNone(project))
      return yield* Effect.fail(new NotesError({ message: "This thread has no project." }));
    const config = yield* settings.getSettings;
    return {
      folder: resolveNotesFolder(config.research.notesFolder),
      runDirectory: yield* resolveResearchRunDirectory(project.value.workspaceRoot, threadId),
    };
  });

const listThreadNotesImpl = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const context = yield* contextFor(threadId);
    const platform = yield* HostProcess.Platform;
    const folderError = !context.folder
      ? null
      : yield* Effect.tryPromise(async () => {
          await safeDirectory(context.folder, false, platform);
          await NodeFSP.access(context.folder, NodeFSP.constants.R_OK | NodeFSP.constants.W_OK);
        }).pipe(
          Effect.match({
            onSuccess: () => null,
            onFailure: () => "Notes folder is unavailable. Check its path and permissions.",
          }),
        );
    const entries = (yield* readResearchLedger(context.runDirectory)).filter((entry) =>
      entryBelongsToThread(entry, threadId),
    );
    return {
      folder: context.folder,
      folderStatus: !context.folder
        ? ("disabled" as const)
        : folderError
          ? ("unavailable" as const)
          : ("available" as const),
      error:
        folderError ?? entries.toReversed().find((entry) => entry.notesError)?.notesError ?? null,
      // No vault-wide scan or retrieval: the selected thread's ledger is the index.
      entries: entries.toReversed().map(({ artifact, step, visit, runId, outcome, at, chars }) => ({
        artifact,
        step,
        visit,
        runId,
        outcome,
        at,
        chars,
      })),
    };
  });

const readThreadNoteImpl = (input: { threadId: ThreadId; artifact: string; offset: number }) =>
  Effect.gen(function* () {
    const context = yield* contextFor(input.threadId);
    const entries = (yield* readResearchLedger(context.runDirectory)).filter((entry) =>
      entryBelongsToThread(entry, input.threadId),
    );
    if (!entries.some((entry) => entry.artifact === input.artifact))
      return yield* Effect.fail(
        new NotesError({ message: "Artifact is not in this thread's ledger." }),
      );
    const result = yield* readRunArtifact({
      runDirectory: context.runDirectory,
      artifact: input.artifact,
      threadId: input.threadId,
      offset: Math.max(0, input.offset),
    });
    if (!result.ok) return yield* Effect.fail(new NotesError({ message: result.detail }));
    return {
      artifact: result.artifact,
      text: result.text,
      totalChars: result.totalChars,
      nextOffset: result.nextOffset,
    };
  });

export class ResearchNotes extends Context.Service<
  ResearchNotes,
  {
    readonly list: (threadId: ThreadId) => Effect.Effect<NotesListResult, NotesError>;
    readonly read: (input: {
      threadId: ThreadId;
      artifact: string;
      offset: number;
    }) => Effect.Effect<NotesReadResult, NotesError>;
  }
>()("d4research/mcp/toolkits/research/notes/ResearchNotes") {}

const isNotesError = Schema.is(NotesError);
const make = Effect.gen(function* () {
  const context = yield* Effect.context<
    ProjectionStoreV2 | ProjectStoreV2 | ServerSettingsService | Path.Path | FileSystem.FileSystem
  >();
  const normalizeError = (cause: unknown) =>
    isNotesError(cause)
      ? cause
      : new NotesError({
          message: "Could not read research artifacts. Check project folder permissions.",
        });
  return ResearchNotes.of({
    list: (threadId) =>
      listThreadNotesImpl(threadId).pipe(
        Effect.provideContext(context),
        Effect.mapError(normalizeError),
      ),
    read: (input) =>
      readThreadNoteImpl(input).pipe(
        Effect.provideContext(context),
        Effect.mapError(normalizeError),
      ),
  });
});
export const layer = Layer.effect(ResearchNotes, make);
export const listThreadNotes = (threadId: ThreadId) =>
  Effect.flatMap(ResearchNotes, (service) => service.list(threadId)).pipe(Effect.provide(layer));
export const readThreadNote = (input: { threadId: ThreadId; artifact: string; offset: number }) =>
  Effect.flatMap(ResearchNotes, (service) => service.read(input)).pipe(Effect.provide(layer));
