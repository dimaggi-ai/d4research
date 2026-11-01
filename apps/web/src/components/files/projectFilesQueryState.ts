import { useAtomValue } from "@effect/atom-react";
import type { ProjectEntriesChangedEvent, ProjectFileChangedEvent } from "@d4research/contracts";
import {
  type EnvironmentId,
  type ProjectFileLocation,
  type ProjectListEntriesResult,
  type ProjectLocateFileResult,
  ProjectReadFileError,
  type ProjectReadFileResult,
  T3_PROJECT_FILE_NAME,
} from "@d4research/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useEffect, useRef } from "react";
import { filePreviewKind } from "@d4research/shared/filePreview";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useProjectPathSearch } from "~/state/queries";
import { executeAtomQuery } from "@d4research/client-runtime/state/runtime";
import { revisionedQuery } from "~/state/revisionedQuery";

const EMPTY_PROJECT_FILE_PATH = "";
const FILE_REVISION_CHECK_INTERVAL_MS = 10_000;
const EMPTY_PROJECT_ENTRIES_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectListEntriesResult, never>(false),
);
const EMPTY_PROJECT_FILE_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectReadFileResult, never>(false),
).pipe(Atom.withLabel("project-file-query:empty"));
const EMPTY_PROJECT_FILE_WATCH_ATOM = Atom.make(
  AsyncResult.initial<ProjectFileChangedEvent, never>(false),
).pipe(Atom.withLabel("project-file-watch:empty"));
const EMPTY_PROJECT_FILE_LOCATIONS_ATOM = Atom.make(
  AsyncResult.initial<ProjectLocateFileResult, never>(false),
).pipe(Atom.withLabel("project-file-locations:empty"));
const EMPTY_PROJECT_ENTRIES_WATCH_ATOM = Atom.make(
  AsyncResult.initial<ProjectEntriesChangedEvent, never>(false),
).pipe(Atom.withLabel("project-entries-watch:empty"));
/** A pending in-app write to the file, overlaying the query until confirmed. */
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
  readonly isFile: boolean;
}

function getProjectEntriesQueryAtom(environmentId: EnvironmentId, cwd: string, directoryPath = "") {
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
    input: {
      cwd,
      relativePath: relativePath ?? EMPTY_PROJECT_FILE_PATH,
      ...(relativePath === T3_PROJECT_FILE_NAME ? { allowMissing: true } : {}),
    },
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
  const data = Option.getOrUndefined(AsyncResult.value(result));
  return data?.exists === false ? undefined : data?.contents;
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

/** `revision` is the workspace mutation id; a new one refetches the listing. */
export function useProjectEntriesQuery(
  environmentId: EnvironmentId,
  cwd: string,
  directoryPath = "",
  active = true,
  revision?: string | null,
): ProjectQueryState<ProjectListEntriesResult> {
  const fileAccess = useFilesystemReadAccess(environmentId);
  const { canReadFiles } = fileAccess;
  const atom = canReadFiles
    ? getProjectEntriesQueryAtom(environmentId, cwd, directoryPath)
    : EMPTY_PROJECT_ENTRIES_QUERY_ATOM;
  const result = useAtomValue(revisionedQuery(atom, canReadFiles ? revision : undefined));
  const refreshing = useRef({ running: false, again: false, generation: 0 });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancel stale directory requests when the active listing lifetime ends.
  useEffect(() => {
    const state = refreshing.current;
    return () => {
      state.generation++;
      state.running = false;
      state.again = false;
    };
  }, [atom, active]);
  const refresh = useCallback(() => {
    const state = refreshing.current;
    if (!active || !canReadFiles || state.running) return;
    state.running = true;
    const generation = state.generation;
    void (async () => {
      try {
        do {
          state.again = false;
          await executeAtomQuery(appAtomRegistry, atom, {
            reportDefect: false,
            reportFailure: false,
            refresh: true,
          });
        } while (state.again && state.generation === generation);
      } finally {
        if (state.generation === generation) state.running = false;
      }
    })();
  }, [active, atom, canReadFiles]);
  const onDirectoryChange = useCallback(() => {
    if (refreshing.current.running) refreshing.current.again = true;
    else refresh();
  }, [refresh]);
  useProjectEntriesWatchRefresh(
    active && canReadFiles ? environmentId : null,
    active && canReadFiles ? cwd : null,
    onDirectoryChange,
    directoryPath,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh the disk listing when its observed permission or root becomes active.
  useEffect(() => {
    refresh();
  }, [refresh]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Register the window focus trigger for the active directory query.
  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [active, refresh]);
  return {
    data: canReadFiles ? Option.getOrNull(AsyncResult.value(result)) : null,
    error: fileAccess.isPending
      ? null
      : canReadFiles
        ? errorMessage(failureCause(result))
        : (fileAccess.error ?? "This connection cannot read host files."),
    isPending: fileAccess.isPending || result.waiting,
    refresh,
  };
}

export function useProjectEntriesWatchRefresh(
  environmentId: EnvironmentId | null,
  cwd: string | null,
  refresh: () => void,
  directoryPath = "",
): void {
  const watchAtom = (
    environmentId !== null && cwd !== null
      ? projectEnvironment.watchEntries({ environmentId, input: { cwd, directoryPath } })
      : EMPTY_PROJECT_ENTRIES_WATCH_ATOM
  ) as Atom.Atom<AsyncResult.AsyncResult<ProjectEntriesChangedEvent, unknown>>;
  const watchResult = useAtomValue(watchAtom);
  const watchRevision = AsyncResult.isSuccess(watchResult) ? watchResult.value.revision : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Forward host filesystem revisions into the listing query.
  useEffect(() => {
    if (watchRevision === null) return;
    refresh();
  }, [refresh, watchRevision]);
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
  watch = false,
  preserveOptimistic = false,
  active = true,
): ProjectFileQueryState {
  // Read media-like paths too; a failed read is how folders with those names are detected.
  const fileAccess = useFilesystemReadAccess(environmentId);
  const { canReadFiles } = fileAccess;
  const isQueryEnabled = enabled;
  const kind = relativePath === null ? null : filePreviewKind({ name: relativePath });
  const metadataOnly =
    kind !== null && !["text", "unsupported", "markdown", "mermaid", "html"].includes(kind);
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
  const shouldWatch = shouldValidate && watch;
  const watchAtom = shouldWatch
    ? projectEnvironment.watchFile({
        environmentId,
        input: { cwd, relativePath },
      })
    : EMPTY_PROJECT_FILE_WATCH_ATOM;
  const watchResult = useAtomValue(watchAtom);
  const watchRevision = AsyncResult.isSuccess(watchResult) ? watchResult.value.revision : null;
  const targetKey = shouldValidate ? `${environmentId}\u0000${cwd}\u0000${relativePath}` : null;
  const checkState = useRef({ generation: 0, running: false, again: false });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Invalidate in-flight disk revisions when file identity or dirty ownership changes.
  useEffect(() => {
    const state = checkState.current;
    return () => {
      state.generation++;
      state.running = false;
      state.again = false;
    };
  }, [atom, targetKey, preserveOptimistic]);
  const refresh = useCallback(() => {
    if (!enabled || !canReadFiles || relativePath === null || !active || preserveOptimistic) return;
    const state = checkState.current;
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
  }, [active, atom, canReadFiles, cwd, enabled, environmentId, preserveOptimistic, relativePath]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Validate disk contents when the host watch emits a revision.
  useEffect(() => {
    if (shouldValidate) refresh();
  }, [refresh, shouldValidate, watchRevision]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Own the selected visible file metadata timer and visibility listener.
  useEffect(() => {
    if (!shouldWatch || preserveOptimistic) return;
    // Host watcher events are best effort (reconnects/atomic replacements can
    // lose them). Check only disk metadata while visible; unchanged files keep
    // their cached object and never retransmit contents or reset the editor.
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
  }, [preserveOptimistic, refresh, shouldWatch]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Register window focus validation for the selected file.
  useEffect(() => {
    if (targetKey === null || typeof window === "undefined") return;
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh, targetKey]);
  const readData = Option.getOrNull(AsyncResult.value(result));
  const isMissing = readData?.exists === false;
  const optimisticResult = useAtomValue(
    optimisticFileAtom(environmentId, cwd, relativePath ?? EMPTY_PROJECT_FILE_PATH),
  );
  const optimisticFile = relativePath === null ? null : optimisticResult;
  const cause = failureCause(result);
  const readError = isProjectReadFileError(cause)
    ? cause
    : isMissing && !optimisticFile && relativePath !== null
      ? new ProjectReadFileError({ cwd, relativePath, failure: "path_not_found" })
      : null;
  const data = canReadFiles
    ? (optimisticFile?.data ?? (isMissing || result._tag === "Failure" ? null : readData))
    : null;
  const isNotFile = readError?.failure === "path_not_file";

  return {
    data,
    error:
      !isQueryEnabled || fileAccess.isPending
        ? null
        : canReadFiles
          ? isMissing && !optimisticFile
            ? `'${relativePath}' does not exist.`
            : errorMessage(cause)
          : (fileAccess.error ?? "This connection cannot read host files."),
    isPending: isQueryEnabled && (fileAccess.isPending || result.waiting),
    readError,
    isNotFile,
    // A folder error overrides cached contents retained across failed refreshes.
    isFile: !isNotFile && (data !== null || readError?.failure === "binary_file"),
    refresh,
  };
}

export function useProjectFileLocations(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  enabled: boolean,
): { readonly locations: ReadonlyArray<ProjectFileLocation>; readonly isPending: boolean } {
  const result = useAtomValue(
    enabled && relativePath !== null
      ? projectEnvironment.locateFile({ environmentId, input: { cwd, relativePath } })
      : EMPTY_PROJECT_FILE_LOCATIONS_ATOM,
  );
  return {
    locations: Option.getOrNull(AsyncResult.value(result))?.locations ?? [],
    isPending: enabled && result._tag === "Initial",
  };
}
