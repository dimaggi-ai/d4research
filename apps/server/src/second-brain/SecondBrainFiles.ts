import * as HostProcess from "@d4research/shared/HostProcess";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Descriptor-based no-follow traversal and bounded reads are the vault security boundary.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure path operations also run inside synchronous SQLite and filesystem boundaries.
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous hashing and exclusive temporary names are required inside the filesystem transaction.
import * as NodeCrypto from "node:crypto";
import { SecondBrainError } from "@d4research/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { contentHash, NOTE_BYTES } from "./noteDocument.ts";

const isBrainError = Schema.is(SecondBrainError);

export type FileSnapshot = { content: string; hash: string; size: number; mtime: number };
export type VaultWalk = {
  files: Array<{ path: string; size: number; mtime: number }>;
  truncated: boolean;
};
export class SecondBrainFiles extends Context.Service<
  SecondBrainFiles,
  {
    readonly root: (configured: string) => Effect.Effect<string, SecondBrainError>;
    readonly read: (root: string, file: string) => Effect.Effect<FileSnapshot, SecondBrainError>;
    readonly walk: (root: string) => Effect.Effect<VaultWalk, SecondBrainError>;
    readonly write: (
      root: string,
      file: string,
      content: string,
      expectedHash: string | null,
    ) => Effect.Effect<FileSnapshot, SecondBrainError>;
  }
>()("d4research/second-brain/SecondBrainFiles") {}

function normalizeError(error: unknown): SecondBrainError {
  if (isBrainError(error)) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  return new SecondBrainError({
    code:
      code === "ENOENT"
        ? "not_found"
        : code === "ELOOP" || code === "ENOTDIR"
          ? "unsafe_path"
          : "unavailable",
  });
}
function components(file: string) {
  const parts = file.split("/");
  if (
    file.length > 1024 ||
    NodePath.isAbsolute(file) ||
    file.includes("\\") ||
    file.includes(":") ||
    file.includes("\0") ||
    !/\.md$/i.test(file) ||
    parts.some((p) => !p || p.startsWith(".")) ||
    parts.length > 17
  )
    throw new SecondBrainError({ code: "invalid_path" });
  return parts;
}
// Linux directory descriptors pin ancestors across concurrent renames. Other platforms
// revalidate components but require the vault's directories to be owned by a trusted editor.
function directoryPath(fd: number, fallback: string, platform: string) {
  return platform === "linux" ? `/proc/self/fd/${fd}` : fallback;
}
function withParent<A>(
  root: string,
  file: string,
  create: boolean,
  platform: string,
  use: (target: string, parent: string) => A,
): A {
  const parts = components(file);
  const handles: number[] = [];
  try {
    let parent = root;
    for (let i = -1; i < parts.length - 1; i++) {
      const current = i === -1 ? root : NodePath.join(parent, parts[i]!);
      if (create && i >= 0) {
        try {
          NodeFS.mkdirSync(current, { mode: 0o700 });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        }
      }
      const info = NodeFS.lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new SecondBrainError({ code: "unsafe_path" });
      if (platform === "win32") parent = current;
      else {
        const fd = NodeFS.openSync(
          current,
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
        );
        handles.push(fd);
        parent = directoryPath(fd, current, platform);
      }
    }
    const target = NodePath.join(parent, parts.at(-1)!);
    try {
      const info = NodeFS.lstatSync(target);
      if (info.isSymbolicLink() || !info.isFile())
        throw new SecondBrainError({ code: "unsafe_path" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return use(target, parent);
  } finally {
    for (const fd of handles.toReversed()) NodeFS.closeSync(fd);
  }
}
function readTarget(target: string): FileSnapshot {
  const fd = NodeFS.openSync(
    target,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const stat = NodeFS.fstatSync(fd);
    if (!stat.isFile()) throw new SecondBrainError({ code: "unsafe_path" });
    if (stat.size > NOTE_BYTES) throw new SecondBrainError({ code: "oversized" });
    const buffer = Buffer.alloc(NOTE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = NodeFS.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > NOTE_BYTES) throw new SecondBrainError({ code: "oversized" });
    const content = buffer.subarray(0, length).toString("utf8");
    return { content, hash: contentHash(content), size: length, mtime: stat.mtimeMs };
  } finally {
    NodeFS.closeSync(fd);
  }
}
const attempt = <A>(body: () => A) => Effect.try({ try: body, catch: normalizeError });
const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  return SecondBrainFiles.of({
    root: (configured) =>
      attempt(() => {
        if (!configured) throw new SecondBrainError({ code: "disabled" });
        const expanded =
          configured === "~"
            ? NodeOS.homedir()
            : configured.startsWith("~/")
              ? NodePath.join(NodeOS.homedir(), configured.slice(2))
              : configured;
        const root = NodeFS.realpathSync(expanded);
        if (!NodeFS.statSync(root).isDirectory())
          throw new SecondBrainError({ code: "invalid_path" });
        return root;
      }),
    read: (root, file) => attempt(() => withParent(root, file, false, platform, readTarget)),
    walk: (root) =>
      attempt(() => {
        const files: VaultWalk["files"] = [];
        let entries = 0;
        let truncated = false;
        const walk = (directory: string, relative: string, depth: number) => {
          const info = NodeFS.lstatSync(directory);
          if (!info.isDirectory() || info.isSymbolicLink())
            throw new SecondBrainError({ code: "unsafe_path" });
          const fd =
            platform === "win32"
              ? undefined
              : NodeFS.openSync(
                  directory,
                  NodeFS.constants.O_RDONLY |
                    NodeFS.constants.O_DIRECTORY |
                    NodeFS.constants.O_NOFOLLOW,
                );
          let dir: NodeFS.Dir | undefined;
          try {
            const pinned = fd === undefined ? directory : directoryPath(fd, directory, platform);
            dir = NodeFS.opendirSync(pinned);
            let entry: NodeFS.Dirent | null;
            while ((entry = dir.readSync()) !== null) {
              if (++entries > 10000) {
                truncated = true;
                break;
              }
              if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
              const target = NodePath.join(pinned, entry.name);
              const name = relative ? `${relative}/${entry.name}` : entry.name;
              const stat = NodeFS.lstatSync(target);
              if (stat.isSymbolicLink()) throw new SecondBrainError({ code: "unsafe_path" });
              if (stat.isDirectory()) {
                if (depth >= 16) truncated = true;
                else walk(target, name, depth + 1);
              } else if (/\.md$/i.test(entry.name)) {
                if (!stat.isFile()) throw new SecondBrainError({ code: "unsafe_path" });
                files.push({ path: name, size: stat.size, mtime: stat.mtimeMs });
              }
              if (truncated && entries > 10000) break;
            }
          } finally {
            dir?.closeSync();
            if (fd !== undefined) NodeFS.closeSync(fd);
          }
        };
        walk(root, "", 0);
        return { files: files.sort((a, b) => a.path.localeCompare(b.path)), truncated };
      }),
    write: (root, file, content, expectedHash) =>
      attempt(() => {
        if (Buffer.byteLength(content) > NOTE_BYTES)
          throw new SecondBrainError({ code: "oversized" });
        return withParent(root, file, true, platform, (target, parent) => {
          const currentHash = () => {
            try {
              return readTarget(target).hash;
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
              throw e;
            }
          };
          if (currentHash() !== expectedHash)
            throw new SecondBrainError({ code: "stale_revision" });
          const temporary = NodePath.join(parent, `.d4-${NodeCrypto.randomUUID()}.tmp`);
          let fd: number | undefined;
          try {
            fd = NodeFS.openSync(temporary, "wx", 0o600);
            NodeFS.writeFileSync(fd, content, "utf8");
            NodeFS.fsyncSync(fd);
            NodeFS.closeSync(fd);
            fd = undefined;
            if (currentHash() !== expectedHash)
              throw new SecondBrainError({ code: "stale_revision" });
            NodeFS.renameSync(temporary, target);
            return readTarget(target);
          } finally {
            if (fd !== undefined) NodeFS.closeSync(fd);
            try {
              NodeFS.unlinkSync(temporary);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
                // eslint-disable-next-line no-unsafe-finally -- Cleanup failures must not be reported as successful writes.
                throw e;
              }
            }
          }
        });
      }),
  });
});
export const layer = Layer.effect(SecondBrainFiles, make);
