// @effect-diagnostics nodeBuiltinImport:off - Native no-follow file handles and exclusive publishing protect artifact boundaries.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

const MAX_SYSTEM_SYMLINKS = 40;

// Root-owned links in a directory only root can rename, such as /tmp -> /private/tmp on
// macOS or /home -> /var/home on Fedora Atomic, cannot be swapped by the agent's user.
// Following them is safe; any other symlink is refused. Windows reports uid 0 for every
// file, so it never qualifies.
function systemSymlink(parent: NodeFS.Stats, link: NodeFS.Stats, platform: NodeJS.Platform) {
  return (
    platform !== "win32" &&
    link.isSymbolicLink() &&
    link.uid === 0 &&
    parent.uid === 0 &&
    ((parent.mode & 0o002) === 0 || (parent.mode & 0o1000) !== 0)
  );
}

// Linux supports descriptor-relative traversal through procfs. Retain a directory
// handle while operating so a concurrent parent rename/symlink swap cannot redirect I/O.
async function anchorDirectory(
  directory: string,
  create = false,
  hops = 0,
): Promise<NodeFSP.FileHandle> {
  if (directory.split(NodePath.sep).includes(".."))
    throw new Error("Artifact paths cannot contain parent traversal.");
  if (!NodePath.isAbsolute(directory)) throw new Error("Notes folder must be an absolute path.");
  const parts = directory.split("/").filter(Boolean);
  let handle = await NodeFSP.open("/", NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY);
  try {
    for (const [index, part] of parts.entries()) {
      const child = `/proc/self/fd/${handle.fd}/${part}`;
      if (create)
        await NodeFSP.mkdir(child, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      const next = await NodeFSP.open(
        child,
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
      ).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOTDIR" && error.code !== "ELOOP") throw error;
        if (
          hops < MAX_SYSTEM_SYMLINKS &&
          systemSymlink(await handle.stat(), await NodeFSP.lstat(child), "linux")
        )
          return NodePath.resolve(
            `/${parts.slice(0, index).join("/")}`,
            await NodeFSP.readlink(child),
            ...parts.slice(index + 1),
          );
        throw new Error("Artifact folder paths cannot contain symlinks.");
      });
      await handle.close();
      // The rewritten path is walked again from the root, so every component is rechecked.
      if (typeof next === "string") return await anchorDirectory(next, create, hops + 1);
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function withDirectory<A>(
  directory: string,
  run: (anchored: string) => Promise<A>,
  platform: NodeJS.Platform,
): Promise<A> {
  if (platform !== "linux") return run(await safeDirectory(directory, false, platform));
  const handle = await anchorDirectory(directory);
  try {
    return await run(`/proc/self/fd/${handle.fd}`);
  } finally {
    await handle.close();
  }
}

// Check every component, including existing parents. Never traverse a vault symlink.
export async function safeDirectory(
  directory: string,
  create: boolean,
  platform: NodeJS.Platform,
): Promise<string> {
  if (directory.split(NodePath.sep).includes(".."))
    throw new Error("Artifact paths cannot contain parent traversal.");
  if (!NodePath.isAbsolute(directory)) throw new Error("Notes folder must be an absolute path.");
  const resolved = NodePath.resolve(directory);
  if (platform === "linux") {
    const handle = await anchorDirectory(directory, create);
    await handle.close();
    return resolved;
  }
  let walked = resolved;
  for (let hops = 0; ; hops += 1) {
    const root = NodePath.parse(walked).root;
    const parts = walked.slice(root.length).split(NodePath.sep).filter(Boolean);
    let current = root;
    let rewritten: string | null = null;
    for (const [index, part] of parts.entries()) {
      const parent = current;
      current = NodePath.join(current, part);
      if (create)
        await NodeFSP.mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      const stat = await NodeFSP.lstat(current);
      if (stat.isDirectory()) continue;
      if (
        hops < MAX_SYSTEM_SYMLINKS &&
        systemSymlink(await NodeFSP.lstat(parent), stat, platform)
      ) {
        rewritten = NodePath.resolve(
          parent,
          await NodeFSP.readlink(current),
          ...parts.slice(index + 1),
        );
        break;
      }
      throw new Error("Artifact folder paths cannot contain symlinks.");
    }
    if (rewritten === null) return resolved;
    walked = rewritten;
  }
}

export async function safeRead(file: string, platform: NodeJS.Platform): Promise<string> {
  return withDirectory(
    NodePath.dirname(file),
    async (directory) => {
      const handle = await NodeFSP.open(
        NodePath.join(directory, NodePath.basename(file)),
        NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
      );
      try {
        let stat = await handle.stat();
        // A process can stop between publishing the hard link and removing its
        // app-owned temporary name. Only that exact sibling inode is recoverable.
        if (stat.isFile() && stat.nlink === 2) {
          for (const name of await NodeFSP.readdir(directory)) {
            if (
              !/^\.d4-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/.test(name)
            )
              continue;
            const temporary = NodePath.join(directory, name);
            const candidate = await NodeFSP.lstat(temporary).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
                return null;
              },
            );
            if (candidate?.isFile() && candidate.dev === stat.dev && candidate.ino === stat.ino) {
              await NodeFSP.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
              });
              break;
            }
          }
          stat = await handle.stat();
        }
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024)
          throw new Error("Artifact is not a supported regular file.");
        return await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    },
    platform,
  );
}

// Publish with link, not rename: an existing user file must never be replaced.
export async function publishArtifact(
  file: string,
  text: string,
  platform: NodeJS.Platform,
): Promise<void> {
  return withDirectory(
    NodePath.dirname(file),
    async (directory) => {
      const target = NodePath.join(directory, NodePath.basename(file));
      const temporary = NodePath.join(directory, `.d4-${NodeCrypto.randomUUID()}.tmp`);
      const handle = await NodeFSP.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await NodeFSP.link(temporary, target);
      } finally {
        await NodeFSP.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          // A reader may already have recovered this completed publication.
          if (error.code !== "ENOENT") throw error;
        });
      }
    },
    platform,
  );
}

export async function appendLedger(
  file: string,
  line: string,
  platform: NodeJS.Platform,
): Promise<void> {
  return withDirectory(
    NodePath.dirname(file),
    async (directory) => {
      const handle = await NodeFSP.open(
        NodePath.join(directory, NodePath.basename(file)),
        NodeFS.constants.O_WRONLY |
          NodeFS.constants.O_CREAT |
          NodeFS.constants.O_APPEND |
          NodeFS.constants.O_NOFOLLOW |
          NodeFS.constants.O_NONBLOCK,
        0o600,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("Ledger must be a regular file.");
        await handle.writeFile(line, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    platform,
  );
}

export async function safeList(directory: string, platform: NodeJS.Platform): Promise<string[]> {
  return withDirectory(directory, (anchored) => NodeFSP.readdir(anchored), platform);
}
