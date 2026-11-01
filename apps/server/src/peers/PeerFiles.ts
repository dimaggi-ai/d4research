// @effect-diagnostics nodeBuiltinImport:off
/**
 * The files this environment lets another one list, read and write for agents (see
 * `packages/contracts/src/peers.ts`). Every path must resolve inside a project folder or a thread
 * worktree of this environment, so a request relayed from another machine cannot reach the rest
 * of the disk.
 *
 * @module PeerFiles
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import {
  PEER_FILES_LIST_MAX_ENTRIES,
  type PeerFileEntry,
  PeerFilesError,
  type PeerFilesFailureCode,
  type PeerFilesListInput,
  type PeerFilesListResult,
  type PeerFilesReadInput,
  type PeerFilesReadResult,
  type PeerFilesWriteInput,
  type PeerFilesWriteResult,
} from "@d4research/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/** Listed as folders but not walked: their contents are rebuilt, not copied. */
const UNWALKED_DIRECTORIES = new Set([".git", "node_modules"]);

export class PeerFiles extends Context.Service<
  PeerFiles,
  {
    readonly list: (
      input: PeerFilesListInput,
    ) => Effect.Effect<PeerFilesListResult, PeerFilesError>;
    readonly read: (
      input: PeerFilesReadInput,
    ) => Effect.Effect<PeerFilesReadResult, PeerFilesError>;
    /**
     * Collects chunks in a temporary file beside the destination and renames it over the
     * destination with the last one, so a broken transfer never leaves a half-written file there.
     */
    readonly write: (
      input: PeerFilesWriteInput,
    ) => Effect.Effect<PeerFilesWriteResult, PeerFilesError>;
  }
>()("d4research/peers/PeerFiles") {}

const failure = (code: PeerFilesFailureCode, message: string) =>
  new PeerFilesError({ code, message });

const errorCode = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;

const isPeerFilesError = Schema.is(PeerFilesError);

const toFailure = (cause: unknown) =>
  isPeerFilesError(cause)
    ? cause
    : errorCode(cause) === "ENOENT"
      ? failure("not_found", "No such file or directory.")
      : failure("io_failed", cause instanceof Error ? cause.message : "The file operation failed.");

const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toFailure });

/** The real path of `target`, whose trailing segments may not exist yet. */
async function realPathAllowingMissing(target: string): Promise<string> {
  const missing: Array<string> = [];
  let current = target;
  for (;;) {
    try {
      return NodePath.join(await NodeFSP.realpath(current), ...missing);
    } catch (cause) {
      const parent = NodePath.dirname(current);
      if (errorCode(cause) !== "ENOENT" || parent === current) throw cause;
      missing.unshift(NodePath.basename(current));
      current = parent;
    }
  }
}

async function resolveInside(roots: ReadonlyArray<string>, requested: string): Promise<string> {
  if (!NodePath.isAbsolute(requested)) {
    throw failure("outside_projects", "Use an absolute path. t3_peers_list shows each folder.");
  }
  const real = await realPathAllowingMissing(NodePath.resolve(requested));
  for (const root of roots) {
    const realRoot = await NodeFSP.realpath(root).catch(() => null);
    if (realRoot !== null && (real === realRoot || real.startsWith(realRoot + NodePath.sep))) {
      return real;
    }
  }
  throw failure(
    "outside_projects",
    `${requested} is not inside a project folder or thread worktree of this environment.`,
  );
}

async function sha256(path: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  await NodeStreamPromises.pipeline(NodeFS.createReadStream(path), hash);
  return hash.digest("hex");
}

async function describeEntry(
  directory: string,
  relativePath: string,
  hash: boolean,
): Promise<PeerFileEntry> {
  const absolutePath = NodePath.join(directory, relativePath);
  const stat = await NodeFSP.lstat(absolutePath);
  const kind = stat.isFile()
    ? "file"
    : stat.isDirectory()
      ? "directory"
      : stat.isSymbolicLink()
        ? "symlink"
        : "other";
  return {
    path: relativePath.split(NodePath.sep).join("/"),
    kind,
    size: kind === "file" ? stat.size : 0,
    modifiedAt: stat.mtime.toISOString(),
    ...(hash && kind === "file" ? { sha256: await sha256(absolutePath) } : {}),
  };
}

async function walk(directory: string, input: PeerFilesListInput) {
  const entries: Array<PeerFileEntry> = [];
  const pending = [""];
  while (pending.length > 0) {
    const relativeDirectory = pending.shift()!;
    const names = (await NodeFSP.readdir(NodePath.join(directory, relativeDirectory))).sort();
    for (const name of names) {
      if (entries.length >= PEER_FILES_LIST_MAX_ENTRIES) return { entries, truncated: true };
      const entry = await describeEntry(
        directory,
        NodePath.join(relativeDirectory, name),
        input.hash,
      );
      entries.push(entry);
      if (input.recursive && entry.kind === "directory" && !UNWALKED_DIRECTORIES.has(name)) {
        pending.push(NodePath.join(relativeDirectory, name));
      }
    }
  }
  return { entries, truncated: false };
}

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const roots = Effect.gen(function* () {
    const snapshot = yield* projects.snapshot;
    const shells = yield* threads.getShellSnapshot();
    return [
      ...snapshot.projects.flatMap((project) =>
        project.deletedAt === null ? [project.workspaceRoot] : [],
      ),
      ...shells.threads.flatMap((thread) =>
        thread.worktreePath === null ? [] : [thread.worktreePath],
      ),
    ];
  }).pipe(
    Effect.mapError(() => failure("io_failed", "Could not read this environment's projects.")),
  );

  const resolve = (path: string) =>
    Effect.flatMap(roots, (allowed) => io(() => resolveInside(allowed, path)));

  const untracked = Effect.fn("PeerFiles.untracked")(function* (directory: string) {
    const result = yield* git
      .execute({
        operation: "PeerFiles.untracked",
        cwd: directory,
        args: ["ls-files", "--others", "--directory", "-z"],
        maxOutputBytes: 1024 * 1024,
      })
      .pipe(
        Effect.mapError(() =>
          failure(
            "not_a_repository",
            "untrackedOnly needs a Git repository. List this folder without it.",
          ),
        ),
      );
    const paths = result.stdout
      .split("\0")
      .filter((path) => path.length > 0)
      .map((path) => (path.endsWith("/") ? path.slice(0, -1) : path));
    return {
      paths: paths.slice(0, PEER_FILES_LIST_MAX_ENTRIES),
      truncated: result.stdoutTruncated || paths.length > PEER_FILES_LIST_MAX_ENTRIES,
    };
  });

  const list: PeerFiles["Service"]["list"] = Effect.fn("PeerFiles.list")(function* (input) {
    const path = yield* resolve(input.path);
    const stat = yield* io(() => NodeFSP.stat(path));
    if (!stat.isDirectory()) {
      const entry = yield* io(() =>
        describeEntry(NodePath.dirname(path), NodePath.basename(path), input.hash),
      );
      return { path, kind: "file" as const, entries: [entry], truncated: false };
    }
    const kind = "directory" as const;
    if (!input.untrackedOnly) return { path, kind, ...(yield* io(() => walk(path, input))) };
    const { paths, truncated } = yield* untracked(path);
    const entries = yield* io(() =>
      Promise.all(paths.map((relativePath) => describeEntry(path, relativePath, input.hash))),
    );
    return { path, kind, entries, truncated };
  });

  const read: PeerFiles["Service"]["read"] = Effect.fn("PeerFiles.read")(function* (input) {
    const path = yield* resolve(input.path);
    return yield* io(async () => {
      const handle = await NodeFSP.open(path, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw failure("not_a_file", `${input.path} is not a regular file.`);
        const buffer = Buffer.alloc(Math.max(0, Math.min(input.length, stat.size - input.offset)));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, input.offset);
        return {
          data: buffer.subarray(0, bytesRead).toString("base64"),
          size: stat.size,
          mode: stat.mode & 0o777,
          modifiedAt: stat.mtime.toISOString(),
          eof: input.offset + bytesRead >= stat.size,
        };
      } finally {
        await handle.close();
      }
    });
  });

  const write: PeerFiles["Service"]["write"] = Effect.fn("PeerFiles.write")(function* (input) {
    const path = yield* resolve(input.path);
    return yield* io(async () => {
      const directory = NodePath.dirname(path);
      const transferPrefix = `.${NodePath.basename(path)}.t3-transfer-`;
      const temporaryPath = NodePath.join(directory, `${transferPrefix}${input.transferId}`);
      const bytes = Buffer.from(input.data, "base64");
      if (input.offset === 0) {
        const existing = await NodeFSP.stat(path).catch(() => null);
        if (existing?.isDirectory()) throw failure("not_a_file", `${input.path} is a directory.`);
        if (existing !== null && !input.overwrite) {
          throw failure(
            "already_exists",
            `${input.path} already exists. Pass overwrite to replace it.`,
          );
        }
        await NodeFSP.mkdir(directory, { recursive: true });
        // A transfer that broke earlier left its temporary file behind.
        for (const name of await NodeFSP.readdir(directory)) {
          if (name.startsWith(transferPrefix)) await NodeFSP.rm(NodePath.join(directory, name));
        }
        await NodeFSP.writeFile(temporaryPath, bytes, { mode: 0o600 });
      } else {
        const collected = await NodeFSP.stat(temporaryPath);
        if (collected.size !== input.offset) {
          throw failure(
            "transfer_out_of_order",
            `Expected the chunk at ${collected.size}, got the one at ${input.offset}.`,
          );
        }
        await NodeFSP.appendFile(temporaryPath, bytes);
      }
      const size = input.offset + bytes.length;
      if (!input.last) return { size };
      await NodeFSP.chmod(temporaryPath, (input.mode ?? 0o644) & 0o777);
      await NodeFSP.rename(temporaryPath, path);
      return { size, sha256: await sha256(path) };
    });
  });

  return PeerFiles.of({ list, read, write });
});

export const layer = Layer.effect(PeerFiles, make);
