import { mediaFileReference } from "@d4research/client-runtime/media-reference";
import { resolveMarkdownFileLinkTarget } from "~/markdown-links";
import type {
  AssetResource,
  ProjectFileLocation,
  ProjectReadFileError,
  ScopedThreadRef,
} from "@d4research/contracts";
import { isAbsolutePath, isHostPath, workspaceRelativeFilePath } from "@d4research/shared/path";

export function resolveFilePreviewPath(path: string | null, cwd: string): string | null {
  if (path === null) return null;
  const target = /^(?:\.{1,2}[\\/]|~[\\/]|file:)/i.test(path)
    ? (resolveMarkdownFileLinkTarget(path, cwd) ?? path)
    : path;
  if (target === "." || workspaceRelativeFilePath(target, cwd) === ".") return null;
  return !isAbsolutePath(path) && isAbsolutePath(target)
    ? (workspaceRelativeFilePath(target, cwd) ?? target)
    : target;
}

export const isMarkdownPreviewFile = (path: string): boolean =>
  /\.(?:md|mdx|markdown|mdown|mkd)$/i.test(path);

export function filePreviewReadErrorMessage(error: ProjectReadFileError): string {
  switch (error.failure) {
    case "path_not_file":
      return "The path is a directory or special file, not a regular file.";
    case "binary_file":
      return "The file is binary and cannot be displayed as text.";
    case "workspace_path_outside_root":
      return "The requested path is outside the workspace.";
    case "resolved_path_outside_root":
      return "The path resolves to a location outside the workspace.";
    case "path_not_found":
      return error.cwd && error.relativePath && !isAbsolutePath(error.relativePath)
        ? `This file does not exist in ${error.cwd}.`
        : "This file does not exist.";
    case "operation_failed":
      return error.operation === "realpath-workspace-root"
        ? "The workspace folder could not be accessed."
        : "The file could not be accessed or read. It may be missing or inaccessible.";
    default:
      return error.message;
  }
}

export function siblingWorktreeLabel(location: ProjectFileLocation): string {
  const folder = location.worktreePath.split(/[\\/]/).findLast(Boolean) ?? location.worktreePath;
  return location.branch ? `${folder} (${location.branch})` : folder;
}

export function shouldShowFileExplorer(input: {
  readonly relativePath: string | null;
  readonly explorerOpen: boolean;
  readonly attachmentOpen: boolean;
}): boolean {
  if (input.attachmentOpen || (input.relativePath && isHostPath(input.relativePath))) {
    return false;
  }
  return input.explorerOpen || input.relativePath === null;
}

export type MarkdownPreviewMode = "source" | "rendered";

const MARKDOWN_PREVIEW_MODE_STORAGE_KEY = "t3code.markdownPreviewMode";

interface MarkdownPreviewModeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function normalizeMarkdownPreviewMode(
  value: string | null | undefined,
): MarkdownPreviewMode {
  return value === "rendered" ? "rendered" : "source";
}

export function readMarkdownPreviewMode(
  storage: MarkdownPreviewModeStorage | undefined = typeof window === "undefined"
    ? undefined
    : window.localStorage,
): MarkdownPreviewMode {
  try {
    return normalizeMarkdownPreviewMode(storage?.getItem(MARKDOWN_PREVIEW_MODE_STORAGE_KEY));
  } catch {
    return "source";
  }
}

export function writeMarkdownPreviewMode(
  mode: MarkdownPreviewMode,
  storage: MarkdownPreviewModeStorage | undefined = typeof window === "undefined"
    ? undefined
    : window.localStorage,
): void {
  try {
    storage?.setItem(MARKDOWN_PREVIEW_MODE_STORAGE_KEY, mode);
  } catch {}
}

export function shouldRenderMarkdownPreview(
  path: string | null | undefined,
  mode: MarkdownPreviewMode,
): boolean {
  return Boolean(path && isMarkdownPreviewFile(path) && mode === "rendered");
}

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}

/**
 * The server only signs `workspace-file` assets below the workspace root, so a
 * file opened from outside it, such as an absolute link in the thread, goes
 * through the host `media-file` resource the direct media viewer uses.
 */
export function workspaceAssetResource(input: {
  readonly kind: "workspace-file" | "media-file";
  readonly threadRef: ScopedThreadRef;
  readonly draft: boolean;
  readonly workspaceRoot: string;
  readonly absolutePath: string;
}): AssetResource {
  if (input.draft || workspaceRelativeFilePath(input.absolutePath, input.workspaceRoot) !== null) {
    return { _tag: "draft-workspace-file", cwd: input.workspaceRoot, path: input.absolutePath };
  }
  const insideWorkspace =
    mediaFileReference(input.absolutePath, input.workspaceRoot).relativePath !== undefined;
  return {
    _tag: insideWorkspace ? input.kind : "media-file",
    threadId: input.threadRef.threadId,
    path: input.absolutePath,
  };
}

export function resolveSiblingLookupRoot(
  cwd: string,
  target: string | null,
  knownRoots: ReadonlyArray<string>,
): string {
  if (target === null || !isAbsolutePath(target)) return cwd;
  return (
    [cwd, ...knownRoots]
      .filter((root) => workspaceRelativeFilePath(target, root) !== null)
      .toSorted((left, right) => right.length - left.length)[0] ?? cwd
  );
}
