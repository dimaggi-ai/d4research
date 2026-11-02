// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as RcMap from "effect/RcMap";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  ProjectEntry,
  ProjectEntriesChangedEvent,
  ProjectListEntriesInput,
  ProjectListEntriesResult,
  ProjectListIgnoredFilesInput,
  ProjectListIgnoredFilesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchCodeInput,
  ProjectSearchCodeResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
} from "@d4research/contracts";
import * as HostProcess from "@d4research/shared/HostProcess";
import { isExplicitRelativePath, isWindowsAbsolutePath } from "@d4research/shared/path";
import { normalizeSearchQuery } from "@d4research/shared/searchRanking";

import { expandHomePath } from "@d4research/provider-core/server/pathExpansion";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const MAX_IGNORED_WORKSPACE_ENTRIES = 10_000;
const MAX_WORKSPACE_ENTRIES = 25_000;

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  return separatorIndex === -1 ? undefined : input.slice(0, separatorIndex);
}

function pathDepth(input: string): number {
  let depth = 1;
  for (const character of input) {
    if (character === "/") depth += 1;
  }
  return depth;
}

function normalizeEntryPath(input: string): string {
  return input.replace(/\/+$/, "");
}

function withDirectoryAncestors(entries: ReadonlyArray<ProjectEntry>): ProjectEntry[] {
  const normalizedEntries = entries.map((entry) => ({
    ...entry,
    path: normalizeEntryPath(entry.path),
  }));
  const entriesByPath = new Map(normalizedEntries.map((entry) => [entry.path, entry] as const));
  for (const entry of normalizedEntries) {
    let parentPath = parentPathOf(entry.path);
    while (parentPath) {
      if (!entriesByPath.has(parentPath)) {
        entriesByPath.set(parentPath, { path: parentPath, kind: "directory" });
      }
      parentPath = parentPathOf(parentPath);
    }
  }
  return [...entriesByPath.values()];
}

export class WorkspaceEntriesWindowsPathUnsupportedError extends Schema.TaggedError<WorkspaceEntriesWindowsPathUnsupportedError>()(
  "WorkspaceEntriesWindowsPathUnsupportedError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    platform: Schema.String,
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Windows-style workspace path '${this.partialPath}' is not supported on '${this.platform}'${cwd}.`;
  }
}

export class WorkspaceEntriesCurrentProjectRequiredError extends Schema.TaggedError<WorkspaceEntriesCurrentProjectRequiredError>()(
  "WorkspaceEntriesCurrentProjectRequiredError",
  {
    partialPath: Schema.String,
  },
) {
  override get message(): string {
    return `A current project is required to browse relative workspace path '${this.partialPath}'.`;
  }
}

export class WorkspaceEntriesReadDirectoryError extends Schema.TaggedError<WorkspaceEntriesReadDirectoryError>()(
  "WorkspaceEntriesReadDirectoryError",
  {
    cwd: Schema.optional(Schema.String),
    partialPath: Schema.String,
    parentPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const cwd = this.cwd ? ` from '${this.cwd}'` : "";
    return `Failed to read workspace directory '${this.parentPath}' while browsing '${this.partialPath}'${cwd}.`;
  }
}

export const WorkspaceEntriesBrowseError = Schema.Union([
  WorkspaceEntriesWindowsPathUnsupportedError,
  WorkspaceEntriesCurrentProjectRequiredError,
  WorkspaceEntriesReadDirectoryError,
]);
export type WorkspaceEntriesBrowseError = typeof WorkspaceEntriesBrowseError.Type;

export class WorkspaceEntriesWatchError extends Schema.TaggedError<WorkspaceEntriesWatchError>()(
  "WorkspaceEntriesWatchError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to watch workspace entries in '${this.cwd}'.`;
  }
}

export const WorkspaceEntriesError = Schema.Union([
  WorkspaceEntriesReadDirectoryError,
  WorkspacePaths.WorkspaceRootNotExistsError,
  WorkspacePaths.WorkspaceRootCreateFailedError,
  WorkspacePaths.WorkspaceRootStatFailedError,
  WorkspacePaths.WorkspaceRootNotDirectoryError,
  WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed,
  WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut,
  WorkspaceSearchIndex.WorkspaceSearchIndexSearchFailed,
  WorkspaceEntriesWatchError,
]);
export type WorkspaceEntriesError = typeof WorkspaceEntriesError.Type;

export class WorkspaceEntries extends Context.Service<
  WorkspaceEntries,
  {
    readonly browse: (
      input: FilesystemBrowseInput,
    ) => Effect.Effect<FilesystemBrowseResult, WorkspaceEntriesBrowseError>;
    readonly list: (
      input: ProjectListEntriesInput,
    ) => Effect.Effect<ProjectListEntriesResult, WorkspaceEntriesError>;
    readonly watch: (
      input: ProjectListEntriesInput,
    ) => Stream.Stream<ProjectEntriesChangedEvent, WorkspaceEntriesError>;
    readonly search: (
      input: ProjectSearchEntriesInput,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceEntriesError>;
    readonly listIgnoredFiles: (
      input: ProjectListIgnoredFilesInput,
    ) => Effect.Effect<ProjectListIgnoredFilesResult, WorkspaceEntriesError>;
    readonly searchContents: (
      input: ProjectSearchContentsInput,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceEntriesError>;
    readonly searchCode: (
      input: ProjectSearchCodeInput,
    ) => Effect.Effect<ProjectSearchCodeResult, WorkspaceEntriesError>;
    readonly refresh: (cwd: string) => Effect.Effect<void>;
  }
>()("d4research/workspace/WorkspaceEntries") {}

/** Ignored files offered for copying; more than this is a build folder, not config. */
const IGNORED_FILES_LIMIT = 200;

/** Paths sent to one `git check-ignore` call when labelling a folder's children. */
const IGNORE_CHECK_CHUNK_SIZE = 1000;

/** Children classified at once when listing a folder; each symlink costs a realpath and a stat. */
const SYMLINK_RESOLVE_BATCH_SIZE = 64;

const resolveBrowseTarget = Effect.fn("WorkspaceEntries.resolveBrowseTarget")(function* (
  input: FilesystemBrowseInput,
  path: Path.Path,
): Effect.fn.Return<string, WorkspaceEntriesBrowseError> {
  const platform = yield* HostProcess.Platform;
  if (platform !== "win32" && isWindowsAbsolutePath(input.partialPath)) {
    return yield* new WorkspaceEntriesWindowsPathUnsupportedError({
      cwd: input.cwd,
      partialPath: input.partialPath,
      platform,
    });
  }

  if (!isExplicitRelativePath(input.partialPath)) {
    return path.resolve(expandHomePath(input.partialPath, yield* HostProcess.HomeDirectory));
  }

  if (!input.cwd) {
    return yield* new WorkspaceEntriesCurrentProjectRequiredError({
      partialPath: input.partialPath,
    });
  }
  return path.resolve(
    expandHomePath(input.cwd, yield* HostProcess.HomeDirectory),
    input.partialPath,
  );
});

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceSearchIndexes = yield* WorkspaceSearchIndex.WorkspaceSearchIndexMap;
  const vcsDriverRegistry = yield* Effect.serviceOption(VcsDriverRegistry.VcsDriverRegistry);
  const vcsProcess = yield* VcsProcess.VcsProcess;

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceEntries.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ): Effect.fn.Return<string, WorkspaceEntriesError> {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd);
  });

  const watch: WorkspaceEntries["Service"]["watch"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
        const watchedDirectory = input.directoryPath
          ? (yield* workspacePaths
              .resolveRelativePathWithinRoot({
                workspaceRoot: normalizedCwd,
                relativePath: input.directoryPath,
              })
              .pipe(
                Effect.mapError(
                  (cause) => new WorkspaceEntriesWatchError({ cwd: normalizedCwd, cause }),
                ),
              )).absolutePath
          : normalizedCwd;
        // A tree watches only the levels it displays. Legacy clients without a
        // directoryPath retain their recursive subscription.
        yield* Effect.tryPromise({
          try: async () => {
            const root = await NodeFSP.realpath(normalizedCwd);
            const directory = await NodeFSP.realpath(watchedDirectory);
            const relative = path.relative(root, directory);
            if (
              relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative) ||
              relative.split(path.sep).includes(".git")
            ) {
              throw new Error("Directory must be inside the workspace and outside .git.");
            }
          },
          catch: (cause) => new WorkspaceEntriesWatchError({ cwd: normalizedCwd, cause }),
        });
        const pullChanges = yield* Stream.toPull(
          fileSystem.watch(watchedDirectory, { recursive: input.directoryPath === undefined }),
        );
        const changes = Stream.fromPull(Effect.succeed(pullChanges)).pipe(
          Stream.filter((event) => {
            const eventPath = path
              .relative(normalizedCwd, path.resolve(watchedDirectory, event.path))
              .replaceAll("\\", "/");
            return eventPath !== ".git" && !eventPath.startsWith(".git/");
          }),
          Stream.debounce(Duration.millis(100)),
          Stream.mapAccum(
            () => 1,
            (revision): readonly [number, ReadonlyArray<ProjectEntriesChangedEvent>] => [
              revision + 1,
              [{ revision }],
            ],
          ),
          Stream.mapError((cause) => new WorkspaceEntriesWatchError({ cwd: normalizedCwd, cause })),
        );
        return Stream.concat(Stream.succeed({ revision: 0 }), changes);
      }),
    );

  const refresh: WorkspaceEntries["Service"]["refresh"] = Effect.fn("WorkspaceEntries.refresh")(
    function* (cwd) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(cwd).pipe(
        Effect.orElseSucceed(() => cwd),
      );
      for (const variant of WorkspaceSearchIndex.WORKSPACE_SEARCH_INDEX_VARIANTS) {
        const indexKey = WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, variant);
        if (!(yield* RcMap.has(workspaceSearchIndexes.rcMap, indexKey))) {
          continue;
        }
        const recoverRefreshFailure = Effect.fn("WorkspaceEntries.recoverRefreshFailure")(
          function* (
            cause:
              | WorkspaceSearchIndex.WorkspaceSearchIndexCreateFailed
              | WorkspaceSearchIndex.WorkspaceSearchIndexScanTimedOut
              | WorkspaceSearchIndex.WorkspaceSearchIndexRefreshFailed,
          ) {
            yield* Effect.logWarning("Failed to refresh workspace search index", {
              cwd,
              variant,
              cause,
            });
            yield* workspaceSearchIndexes.invalidate(indexKey);
          },
        );
        yield* Effect.gen(function* () {
          const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
          yield* searchIndex.refresh();
        }).pipe(
          Effect.provide(workspaceSearchIndexes.get(indexKey)),
          Effect.catchTags({
            WorkspaceSearchIndexCreateFailed: recoverRefreshFailure,
            WorkspaceSearchIndexScanTimedOut: recoverRefreshFailure,
            WorkspaceSearchIndexRefreshFailed: recoverRefreshFailure,
          }),
        );
      }
    },
  );

  const browse: WorkspaceEntries["Service"]["browse"] = Effect.fn("WorkspaceEntries.browse")(
    function* (input) {
      const resolvedInputPath = yield* resolveBrowseTarget(input, path);
      const endsWithSeparator = /[\\/]$/.test(input.partialPath) || input.partialPath === "~";
      const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
      const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);

      const dirents = yield* Effect.tryPromise({
        try: () => NodeFSP.readdir(parentPath, { withFileTypes: true }),
        catch: (cause) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: input.cwd,
            partialPath: input.partialPath,
            parentPath,
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) => {
            const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
            return code === "EACCES" || code === "EPERM";
          },
          () => Effect.succeed([]),
        ),
      );

      const showHidden = endsWithSeparator || prefix.startsWith(".");
      const lowerPrefix = prefix.toLowerCase();
      const entries: Array<{ readonly name: string; readonly fullPath: string }> = [];
      for (const dirent of dirents) {
        if (
          dirent.isDirectory() &&
          dirent.name.toLowerCase().startsWith(lowerPrefix) &&
          (showHidden || !dirent.name.startsWith("."))
        ) {
          entries.push({
            name: dirent.name,
            fullPath: path.join(parentPath, dirent.name),
          });
        }
      }

      return {
        parentPath,
        entries: entries.toSorted((left, right) => left.name.localeCompare(right.name)),
      };
    },
  );

  const search: WorkspaceEntries["Service"]["search"] = Effect.fn("WorkspaceEntries.search")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      const normalizedQuery = normalizeSearchQuery(input.query, {
        trimLeadingPattern: /^[@./]+/,
      });
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.search(normalizedQuery, input.limit, input.kind, input.imageOnly);
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
  );

  const searchContents: WorkspaceEntries["Service"]["searchContents"] = Effect.fn(
    "WorkspaceEntries.searchContents",
  )(function* (input) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    return yield* Effect.gen(function* () {
      const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
      return yield* searchIndex.searchContents(input);
    }).pipe(
      Effect.provide(
        workspaceSearchIndexes.get(
          WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "content"),
        ),
      ),
    );
  });

  const searchCode: WorkspaceEntries["Service"]["searchCode"] = Effect.fn(
    "WorkspaceEntries.searchCode",
  )(function* (input) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    return yield* Effect.gen(function* () {
      const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
      return yield* searchIndex.searchCode({
        query: input.query.trim(),
        scope: input.scope,
        limit: input.limit,
      });
    }).pipe(
      Effect.provide(
        workspaceSearchIndexes.get(
          WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "content"),
        ),
      ),
    );
  });

  const list: WorkspaceEntries["Service"]["list"] = Effect.fn("WorkspaceEntries.list")(
    function* (input) {
      const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
      if (input.directoryPath !== undefined) {
        const directoryPath = input.directoryPath;
        const toError = (cause: unknown) =>
          new WorkspaceEntriesReadDirectoryError({
            cwd: normalizedCwd,
            partialPath: directoryPath,
            parentPath: path.resolve(normalizedCwd, directoryPath),
            cause,
          });
        const target =
          directoryPath === ""
            ? { absolutePath: normalizedCwd, relativePath: "" }
            : yield* workspacePaths
                .resolveRelativePathWithinRoot({
                  workspaceRoot: normalizedCwd,
                  relativePath: directoryPath,
                })
                .pipe(Effect.mapError(toError));
        const { entries, throughSymlink } = yield* Effect.tryPromise({
          try: async () => {
            const root = await NodeFSP.realpath(normalizedCwd);
            const directory = await NodeFSP.realpath(target.absolutePath);
            const relative = path.relative(root, directory);
            if (
              relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative) ||
              relative.split(path.sep).includes(".git") ||
              target.relativePath.split("/").includes(".git")
            ) {
              throw new Error("Directory must be inside the workspace and outside .git.");
            }
            const children = await NodeFSP.readdir(directory, { withFileTypes: true });
            const isSameOrInside = (parent: string, child: string) => {
              const relativeChild = path.relative(parent, child);
              return (
                relativeChild !== ".." &&
                !relativeChild.startsWith(`..${path.sep}`) &&
                !path.isAbsolute(relativeChild)
              );
            };
            // Reject canonical ancestors so "Expand all folders" cannot follow a cycle.
            let visitedFolders: Promise<ReadonlyArray<string>> | undefined;
            const loadVisitedFolders = () =>
              (visitedFolders ??= (async () => {
                const folders = [root];
                let current = normalizedCwd;
                for (const segment of target.relativePath.split("/").filter(Boolean)) {
                  current = path.join(current, segment);
                  folders.push(await NodeFSP.realpath(current));
                }
                return folders;
              })());
            const resolveSymlinkKind = async (
              name: string,
            ): Promise<ProjectEntry["kind"] | undefined> => {
              const resolved = await NodeFSP.realpath(path.join(directory, name)).catch(
                () => undefined,
              );
              if (
                resolved === undefined ||
                !isSameOrInside(root, resolved) ||
                path.relative(root, resolved).split(path.sep).includes(".git")
              ) {
                return undefined;
              }
              const stat = await NodeFSP.stat(resolved).catch(() => undefined);
              if (stat?.isFile()) return "file";
              if (!stat?.isDirectory()) return undefined;
              const folders = await loadVisitedFolders();
              return folders.some((folder) => isSameOrInside(resolved, folder))
                ? undefined
                : "directory";
            };
            // Bound filesystem work for directories such as pnpm node_modules.
            const kinds: Array<ProjectEntry["kind"] | undefined> = [];
            for (let offset = 0; offset < children.length; offset += SYMLINK_RESOLVE_BATCH_SIZE) {
              kinds.push(
                ...(await Promise.all(
                  children
                    .slice(offset, offset + SYMLINK_RESOLVE_BATCH_SIZE)
                    .map(async (child): Promise<ProjectEntry["kind"] | undefined> => {
                      if (child.name === ".git") return undefined;
                      if (child.isDirectory()) return "directory";
                      if (child.isFile()) return "file";
                      return child.isSymbolicLink() ? resolveSymlinkKind(child.name) : undefined;
                    }),
                )),
              );
            }
            return {
              entries: children.flatMap((child, index): ProjectEntry[] => {
                const kind = kinds[index];
                if (kind === undefined) return [];
                return [
                  {
                    path: target.relativePath ? `${target.relativePath}/${child.name}` : child.name,
                    kind,
                  },
                ];
              }),
              // Git refuses to classify paths beyond a symbolic link.
              throughSymlink: relative !== target.relativePath.split("/").join(path.sep),
            };
          },
          catch: toError,
        });
        // stdin avoids argument limits; ignore classification is optional without git/repositories.
        const checkIgnore = (paths: ReadonlyArray<string>) =>
          vcsProcess
            .run({
              operation: "WorkspaceEntries.list",
              command: "git",
              args: ["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"],
              cwd: normalizedCwd,
              stdin: `${paths.join("\0")}\0`,
              allowNonZeroExit: true,
              timeoutMs: 10_000,
              maxOutputBytes: 16 * 1024 * 1024,
            })
            .pipe(Effect.orElseSucceed(() => undefined));
        // Check ignored folders once to avoid child index lookups; exit 0 guarantees no tracked descendants.
        // Symlinks and pathspec magic still need per-child checks.
        if (
          entries.length > IGNORE_CHECK_CHUNK_SIZE &&
          target.relativePath !== "" &&
          !throughSymlink &&
          !/^:|[*?[\\]/.test(target.relativePath) &&
          (yield* checkIgnore([target.relativePath]))?.exitCode === 0
        ) {
          return {
            entries: entries.map((entry) => ({ ...entry, ignored: true })),
            truncated: false,
          };
        }
        const ignored = new Set<string>();
        for (let offset = 0; offset < entries.length; offset += IGNORE_CHECK_CHUNK_SIZE) {
          const result = yield* checkIgnore(
            entries.slice(offset, offset + IGNORE_CHECK_CHUNK_SIZE).map((entry) => entry.path),
          );
          if (!result || (result.exitCode !== 0 && result.exitCode !== 1)) break;
          for (const ignoredPath of result.stdout.split("\0")) ignored.add(ignoredPath);
        }
        return {
          entries: entries.map((entry) =>
            ignored.has(entry.path) ? { ...entry, ignored: true } : entry,
          ),
          truncated: false,
        };
      }
      const detected = yield* Option.match(vcsDriverRegistry, {
        onNone: () => Effect.succeed(null),
        onSome: (registry) =>
          registry
            .detect({ cwd: normalizedCwd, requestedKind: "auto" })
            .pipe(Effect.orElseSucceed(() => null)),
      });

      if (detected) {
        const [workspaceFiles, ignoredEntries] = yield* Effect.all([
          detected.driver.listWorkspaceFiles(normalizedCwd).pipe(Effect.option),
          detected.driver.listIgnoredWorkspaceEntries
            ? detected.driver
                .listIgnoredWorkspaceEntries(normalizedCwd)
                .pipe(Effect.orElseSucceed(() => []))
            : Effect.succeed([]),
        ]);
        if (Option.isSome(workspaceFiles)) {
          // Prefer shallow ignored paths so useful project-local folders (for
          // example `local-notes/`) are not crowded out by thousands of deep cache,
          // virtualenv, or node_modules entries.
          const ignoredSlice = ignoredEntries
            .toSorted(
              (left, right) =>
                pathDepth(left.path) - pathDepth(right.path) || left.path.localeCompare(right.path),
            )
            .slice(0, MAX_IGNORED_WORKSPACE_ENTRIES);
          const allEntries = withDirectoryAncestors([
            ...workspaceFiles.value.paths.map((filePath) => ({
              path: normalizeEntryPath(filePath),
              kind: "file" as const,
            })),
            ...ignoredSlice.map((entry) => ({
              ...entry,
              path: normalizeEntryPath(entry.path),
              ignored: true as const,
            })),
          ]).sort((left, right) => left.path.localeCompare(right.path));
          return {
            entries: allEntries.slice(0, MAX_WORKSPACE_ENTRIES),
            truncated:
              workspaceFiles.value.truncated ||
              ignoredEntries.length > MAX_IGNORED_WORKSPACE_ENTRIES ||
              allEntries.length > MAX_WORKSPACE_ENTRIES,
          };
        }
      }

      // The file tree is a live view, not a search-result cache. The first
      // acquisition scans the workspace; every later list call refreshes the
      // existing index before returning it so reopening the panel cannot
      // resurrect an older directory snapshot.
      yield* refresh(normalizedCwd);
      return yield* Effect.gen(function* () {
        const searchIndex = yield* WorkspaceSearchIndex.WorkspaceSearchIndex;
        return yield* searchIndex.list();
      }).pipe(
        Effect.provide(
          workspaceSearchIndexes.get(
            WorkspaceSearchIndex.workspaceSearchIndexKey(normalizedCwd, "paths"),
          ),
        ),
      );
    },
  );

  const listIgnoredFiles: WorkspaceEntries["Service"]["listIgnoredFiles"] = Effect.fn(
    "WorkspaceEntries.listIgnoredFiles",
  )(function* (input) {
    const normalizedCwd = yield* normalizeWorkspaceRoot(input.cwd);
    // `--directory` reports a folder holding nothing but ignored files as one
    // `name/` entry, which is how `node_modules` and build output drop out.
    const result = yield* vcsProcess
      .run({
        operation: "WorkspaceEntries.listIgnoredFiles",
        command: "git",
        args: [
          "-c",
          "core.fsmonitor=false",
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "--directory",
          "--no-empty-directory",
          "-z",
        ],
        cwd: normalizedCwd,
        allowNonZeroExit: true,
        timeoutMs: 10_000,
        maxOutputBytes: 4 * 1024 * 1024,
      })
      .pipe(Effect.orElseSucceed(() => undefined));
    if (!result || result.exitCode !== 0) return { files: [], truncated: false };
    const paths = result.stdout
      .split("\0")
      .filter((entry) => entry.length > 0 && !entry.endsWith("/"))
      .toSorted();
    const files = yield* Effect.promise(() =>
      Promise.all(
        paths.slice(0, IGNORED_FILES_LIMIT).map(async (relativePath) => {
          // lstat: a symlink usually points outside the workspace, where reads refuse to go.
          const stat = await NodeFSP.lstat(path.join(normalizedCwd, relativePath)).catch(
            () => null,
          );
          return stat?.isFile() ? { path: relativePath, byteLength: stat.size } : null;
        }),
      ),
    );
    return {
      files: files.filter((file) => file !== null),
      truncated: paths.length > IGNORED_FILES_LIMIT,
    };
  });

  return WorkspaceEntries.of({
    browse,
    list,
    listIgnoredFiles,
    refresh,
    search,
    searchContents,
    searchCode,
    watch,
  });
});

export const layer = Layer.effect(WorkspaceEntries, make).pipe(
  Layer.provide(WorkspaceSearchIndex.WorkspaceSearchIndexMap.layer),
  Layer.provide(VcsProcess.layer),
);
