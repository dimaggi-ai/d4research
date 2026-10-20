import { useEffect, useRef } from "react";
import { useStableCallback } from "~/hooks/useStableCallback";
import { filePreviewKind } from "@d4research/shared/filePreview";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type ProjectListEntriesResult,
  ProjectReadFileError,
  type ProjectReadFileResult,
} from "@d4research/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useProjectPathSearch } from "~/state/queries";
import { executeAtomQuery } from "@d4research/client-runtime/state/runtime";

const EMPTY_PROJECT_FILE_PATH = "";
const FILE_REVISION_CHECK_INTERVAL_MS = 10_000;

const EMPTY_PROJECT_FILE_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectReadFileResult, never>(false),
).pipe(Atom.withLabel("project-file-query:empty"));
const EMPTY_PROJECT_ENTRIES_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectListEntriesResult, never>(false),
).pipe(Atom.withLabel("project-entries-query:empty"));
export function optimisticFileAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
) {
  return projectEnvironment.optimisticFile({ environmentId, cwd, relativePath });
}

// Dirty contents must survive a closed preview, including failed or unauthorized saves.
const unsavedFileMounts = new Map<ReturnType<typeof optimisticFileAtom>, () => void>();

function releaseUnsavedFile(atom: ReturnType<typeof optimisticFileAtom>): void {
  const unmount = unsavedFileMounts.get(atom);
  unsavedFileMounts.delete(atom);
  unmount?.();
}

interface ProjectQueryState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

interface ProjectFileQueryState extends ProjectQueryState<ProjectReadFileResult> {
  readonly readError: ProjectReadFileError | null;
  readonly isNotFile: boolean;
}

function getProjectEntriesQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  directoryPath?: string,
) {
  return projectEnvironment.listEntries({
    environmentId,
    input: { cwd, ...(directoryPath !== undefined ? { directoryPath } : {}) },
  });
}

export function getProjectFileQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
) {
  return projectEnvironment.readFile({
    environmentId,
    input: { cwd, relativePath: relativePath ?? EMPTY_PROJECT_FILE_PATH },
  });
}

export function setProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): void {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  if (!unsavedFileMounts.has(atom)) {
    unsavedFileMounts.set(atom, appAtomRegistry.mount(atom));
  }
  appAtomRegistry.set(atom, {
    confirmedAgainst: undefined,
    data: {
      relativePath,
      contents,
      byteLength: new TextEncoder().encode(contents).byteLength,
      truncated: false,
    },
  });
}

export function getOptimisticProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? null;
}

export function getProjectFileContents(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): string | undefined {
  const optimistic = getOptimisticProjectFileQueryData(environmentId, cwd, relativePath);
  if (optimistic) return optimistic.contents;
  const result = appAtomRegistry.get(getProjectFileQueryAtom(environmentId, cwd, relativePath));
  return Option.getOrUndefined(AsyncResult.value(result))?.contents;
}

export function getUnsavedProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  const optimistic = appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath));
  return optimistic?.confirmedAgainst === undefined ? (optimistic?.data ?? null) : null;
}

export function confirmProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): boolean {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  const optimisticFile = appAtomRegistry.get(atom);
  if (optimisticFile?.data.contents !== contents) return false;

  const queryAtom = getProjectFileQueryAtom(environmentId, cwd, relativePath);
  const confirmed = {
    ...optimisticFile,
    confirmedAgainst: appAtomRegistry.get(queryAtom),
  };
  appAtomRegistry.set(atom, confirmed);
  releaseUnsavedFile(atom);
  appAtomRegistry.refresh(queryAtom);
  void executeAtomQuery(appAtomRegistry, queryAtom, {
    reportDefect: false,
    reportFailure: false,
  }).then((result) => {
    if (result._tag === "Success" && appAtomRegistry.get(atom) === confirmed) {
      appAtomRegistry.set(atom, null);
    }
  });
  return true;
}

export function resolveProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  data: ProjectReadFileResult | null,
): ProjectReadFileResult | null {
  if (relativePath === null) return data;
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? data;
}

export function clearProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): void {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  appAtomRegistry.set(atom, null);
  releaseUnsavedFile(atom);
}

function failureCause<A>(result: AsyncResult.AsyncResult<A, unknown>): unknown {
  return result._tag === "Failure" ? Cause.squash(result.cause) : null;
}

function errorMessage(cause: unknown): string | null {
  if (cause === null) return null;
  return cause instanceof Error ? cause.message : "Workspace query failed.";
}

const isProjectReadFileError = Schema.is(ProjectReadFileError);

export function useProjectEntriesQuery(
  environmentId: EnvironmentId,
  cwd: string,
  directoryPath?: string,
): ProjectQueryState<ProjectListEntriesResult> {
  const fileAccess = useFilesystemReadAccess(environmentId);
  const { canReadFiles } = fileAccess;
  const atom = canReadFiles
    ? getProjectEntriesQueryAtom(environmentId, cwd, directoryPath)
    : EMPTY_PROJECT_ENTRIES_QUERY_ATOM;
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = () => refreshAtom();
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: fileAccess.isPending
      ? null
      : canReadFiles
        ? errorMessage(failureCause(result))
        : (fileAccess.error ?? "This connection cannot read host files."),
    isPending: fileAccess.isPending || result.waiting,
    refresh,
  };
}

/**
 * An empty query is a valid request — the index answers it with
 * frecency-ordered files, so the picker's initial view is recent files without
 * transferring the full workspace listing.
 */
export function useProjectFilePickerQuery(
  environmentId: EnvironmentId,
  cwd: string,
  query: string,
  limit: number,
  options?: { readonly imageOnly?: boolean },
) {
  const search = useProjectPathSearch(
    {
      environmentId,
      cwd,
      query,
      kind: "file",
      ...(options?.imageOnly ? { imageOnly: true } : {}),
    },
    limit,
    { allowEmptyQuery: true },
  );

  return {
    entries: search.isPending ? [] : search.entries,
    error: search.error,
    isPending: search.isPending,
    matchedQuery: search.searchedQuery,
  };
}

export function useProjectFileQuery(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  enabled = true,
  validateWhileVisible = false,
  preserveOptimistic = false,
  active = true,
): ProjectFileQueryState {
  // A media path is not skipped here: a folder named `assets.png` is only
  // knowable as a folder from the read failure.
  const fileAccess = useFilesystemReadAccess(environmentId);
  const { canReadFiles } = fileAccess;
  const isQueryEnabled = enabled;
  const kind = relativePath === null ? null : filePreviewKind({ name: relativePath });
  const metadataOnly = kind === "image" || kind === "video" || kind === "audio" || kind === "pdf";
  const atom =
    enabled && canReadFiles && relativePath !== null
      ? metadataOnly
        ? projectEnvironment.readFile({
            environmentId,
            input: { cwd, relativePath, metadataOnly: true },
          })
        : getProjectFileQueryAtom(environmentId, cwd, relativePath)
      : EMPTY_PROJECT_FILE_QUERY_ATOM;
  const result = useAtomValue(atom);
  const shouldValidate = enabled && canReadFiles && active && relativePath !== null;
  const shouldPoll = shouldValidate && validateWhileVisible;
  const targetKey = shouldValidate ? `${environmentId}\u0000${cwd}\u0000${relativePath}` : null;
  const checkState = useRef({
    generation: 0,
    running: false,
    again: false,
    targetKey,
    preserveOptimistic,
  });
  useEffect(() => {
    const state = checkState.current;
    state.targetKey = targetKey;
    state.preserveOptimistic = preserveOptimistic;
    return () => {
      state.generation++;
      state.running = false;
      state.again = false;
    };
  }, [targetKey, preserveOptimistic]);
  const refresh = useStableCallback(() => {
    if (!enabled || !canReadFiles || relativePath === null || !active || preserveOptimistic) return;
    const state = checkState.current;
    if (state.targetKey !== targetKey || state.preserveOptimistic) return;
    if (state.running) {
      state.again = true;
      return;
    }
    const generation = state.generation;
    state.running = true;
    const metadataAtom = projectEnvironment.readFile({
      environmentId,
      input: { cwd, relativePath, metadataOnly: true },
    });
    void (async () => {
      try {
        do {
          state.again = false;
          // Finish an initial read before checking, avoiding two full reads on first open.
          await executeAtomQuery(appAtomRegistry, atom, {
            reportDefect: false,
            reportFailure: false,
          });
          if (state.generation !== generation) return;
          const metadata = await executeAtomQuery(appAtomRegistry, metadataAtom, {
            reportDefect: false,
            reportFailure: false,
            refresh: true,
          });
          if (state.generation !== generation) return;
          const currentResult = appAtomRegistry.get(atom);
          const current = Option.getOrNull(AsyncResult.value(currentResult));
          if (
            currentResult._tag === "Failure" ||
            metadata._tag !== "Success" ||
            !current?.revision ||
            metadata.value.revision !== current.revision
          ) {
            clearProjectFileQueryData(environmentId, cwd, relativePath);
            await executeAtomQuery(appAtomRegistry, atom, {
              reportDefect: false,
              reportFailure: false,
              refresh: true,
            });
          }
        } while (state.again && state.generation === generation);
      } finally {
        if (state.generation === generation) state.running = false;
      }
    })();
  });
  useEffect(() => {
    if (targetKey !== null && !preserveOptimistic) refresh();
  }, [refresh, targetKey, preserveOptimistic]);
  useEffect(() => {
    if (!shouldPoll || preserveOptimistic) return;
    // Workspace mutations do not cover every external write. Metadata checks
    // keep unchanged cached objects without retransmitting contents or resetting edits.
    const validateVisibleFile = () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") refresh();
    };
    const interval = setInterval(validateVisibleFile, FILE_REVISION_CHECK_INTERVAL_MS);
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", validateVisibleFile);
    return () => {
      clearInterval(interval);
      if (typeof document !== "undefined")
        document.removeEventListener("visibilitychange", validateVisibleFile);
    };
  }, [preserveOptimistic, refresh, shouldPoll]);
  useEffect(() => {
    if (targetKey === null || typeof window === "undefined") return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh, targetKey]);
  const data = Option.getOrNull(AsyncResult.value(result));
  const optimisticResult = useAtomValue(
    optimisticFileAtom(environmentId, cwd, relativePath ?? EMPTY_PROJECT_FILE_PATH),
  );
  const optimisticFile = relativePath === null ? null : optimisticResult;
  const cause = failureCause(result);
  const readError = isProjectReadFileError(cause) ? cause : null;

  return {
    data: canReadFiles ? (optimisticFile?.data ?? (result._tag === "Failure" ? null : data)) : null,
    error:
      !isQueryEnabled || fileAccess.isPending
        ? null
        : canReadFiles
          ? errorMessage(cause)
          : (fileAccess.error ?? "This connection cannot read host files."),
    isPending: isQueryEnabled && (fileAccess.isPending || result.waiting),
    readError,
    isNotFile: readError?.failure === "path_not_file",
    refresh,
  };
}
