import {
  fileBasename,
  isAbsolutePath,
  normalizeProjectPathForComparison,
  workspaceRelativeFilePath,
} from "@d4research/shared/path";
import {
  inlineCodeFilePathCandidate,
  isRelativeFilePath,
  normalizeMarkdownLinkDestination,
  parseMarkdownFileLink,
  resolveMarkdownFileLinkTarget,
} from "@d4research/shared/markdownLinks";
import { parseFileUrlHref, splitFilePathPosition } from "@d4research/shared/fileLinks";

import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { isTerminalLinkActivation } from "./terminal-links";

export interface MarkdownFileLinkMeta {
  filePath: string;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  line?: number;
  column?: number;
  absoluteReference?: boolean;
}

export function shouldOpenMarkdownFileLinkInEditor(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform?: string,
): boolean {
  return isTerminalLinkActivation(event, platform);
}

export function shouldOpenMarkdownFileLinkInBrowserByDefault(path: string): boolean {
  return /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const target = parseFileUrlHref(normalizeMarkdownLinkDestination(href));
  return target ? `${target.path}${target.hash}` : null;
}

export function resolveInlineCodeFileLinkMeta(
  codeText: string,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const candidate = inlineCodeFilePathCandidate(codeText);
  if (candidate === null) return null;

  return resolveMarkdownFileLinkMeta(
    candidate,
    cwd,
    inlineCodePathNamesFromWorkspaceRoot(candidate, cwd, baseDir) ? cwd : baseDir,
  );
}

function inlineCodePathNamesFromWorkspaceRoot(
  candidate: string,
  cwd: string | undefined,
  baseDir: string | undefined,
): boolean {
  if (!cwd || !baseDir || !isRelativeFilePath(candidate)) return false;
  if (/^(?:~|\.{1,2})\//.test(candidate)) return false;
  if (!splitFilePathPosition(candidate).path.includes("/")) return false;
  return workspaceRelativeFilePath(baseDir, cwd) !== null;
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const resolved = resolveMarkdownFileLinkTarget(href, cwd, baseDir);
  if (!resolved) return null;
  const targetPath = normalizeResolvedFileTarget(resolved);
  const source = href ? parseMarkdownFileLink(href) : null;
  return {
    ...buildFileLinkMetaFromTarget(targetPath, cwd),
    ...(source && isAbsolutePath(source.path) ? { absoluteReference: true } : {}),
  };
}

function buildFileLinkMetaFromTarget(targetPath: string, cwd?: string): MarkdownFileLinkMeta {
  const { path, line, column } = splitFilePathPosition(targetPath);
  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    workspaceRelativePath: workspaceRelativeFilePath(path, cwd),
    basename: fileBasename(path),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

/**
 * A normal file-link click stays inside T3 whenever the path belongs to the
 * active workspace. Browser preview remains an explicit secondary action so
 * generated HTML/PDF files cannot unexpectedly replace the file surface with
 * an asset URL (and a raw HTTP error when that URL is stale).
 */
export function markdownFilePrimaryOpenAction(
  workspaceRelativePath: string | null,
  hasThreadContext: boolean,
): MarkdownFilePrimaryOpenAction {
  return hasThreadContext && workspaceRelativePath ? "file-preview" : "editor";
}

export type MarkdownFilePrimaryOpenAction = "file-preview" | "editor";

export interface MarkdownWorkspaceRootCandidate {
  path: string;
  label?: string | undefined;
}

export interface MarkdownFilePanelTarget {
  path: string;
  workspaceRoot?: string | undefined;
}

function orderedWorkspaceRoots(
  preferredWorkspaceRoot: string | undefined,
  workspaceRoots: ReadonlyArray<MarkdownWorkspaceRootCandidate>,
): MarkdownWorkspaceRootCandidate[] {
  const roots = preferredWorkspaceRoot
    ? [{ path: preferredWorkspaceRoot }, ...workspaceRoots]
    : [...workspaceRoots];
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = normalizeProjectPathForComparison(root.path);
    if (key.length === 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Chooses the project directory that owns a chat file link. A link may be absolute, relative to
 * the active checkout, or prefixed by the name/label of a secondary project directory.
 */
export function resolveMarkdownFilePanelTarget(input: {
  filePath: string;
  panelPath: string;
  preferredWorkspaceRoot?: string | undefined;
  workspaceRoots: ReadonlyArray<MarkdownWorkspaceRootCandidate>;
}): MarkdownFilePanelTarget {
  const roots = orderedWorkspaceRoots(input.preferredWorkspaceRoot, input.workspaceRoots);
  const normalizedPanelPath = input.panelPath
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  const panelSegments = normalizedPanelPath.split("/").filter(Boolean);

  if (
    panelSegments.length > 1 &&
    !normalizedPanelPath.startsWith("/") &&
    !isAbsolutePath(normalizedPanelPath)
  ) {
    const prefix = panelSegments[0]!.toLowerCase();
    const aliasedRoot = roots.find((root) => {
      const aliases = [fileBasename(root.path), root.label]
        .filter((alias): alias is string => typeof alias === "string" && alias.length > 0)
        .map((alias) => alias.toLowerCase());
      return aliases.includes(prefix);
    });
    if (aliasedRoot) {
      return {
        path: panelSegments.slice(1).join("/"),
        workspaceRoot: aliasedRoot.path,
      };
    }
  }

  const owningRoot = roots
    .filter((root) => workspaceRelativeFilePath(input.filePath, root.path) !== null)
    .toSorted((left, right) => right.path.length - left.path.length)[0];
  if (owningRoot) {
    const relativePath = workspaceRelativeFilePath(input.filePath, owningRoot.path);
    if (relativePath !== null) {
      return { path: relativePath, workspaceRoot: owningRoot.path };
    }
  }

  return { path: input.filePath };
}

function normalizeResolvedFileTarget(targetPath: string): string {
  const { path, line, column } = splitFilePathPosition(targetPath);
  const usesBackslashes = path.includes("\\") && !path.includes("/");
  const normalizedSlashes = path.replaceAll("\\", "/");
  const drive = normalizedSlashes.match(/^[A-Za-z]:/)?.[0] ?? "";
  const isUnc = normalizedSlashes.startsWith("//");
  const isAbsolute = normalizedSlashes.startsWith("/") || drive.length > 0;
  const body = drive ? normalizedSlashes.slice(drive.length) : normalizedSlashes;
  const segments: string[] = [];
  for (const segment of body.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") {
        segments.pop();
      } else if (!isAbsolute) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }
  const prefix = drive ? `${drive}/` : isUnc ? "//" : isAbsolute ? "/" : "";
  const normalizedPath = `${prefix}${segments.join("/")}`;
  const restoredPath = usesBackslashes ? normalizedPath.replaceAll("/", "\\") : normalizedPath;
  return line ? `${restoredPath}:${line}${column ? `:${column}` : ""}` : restoredPath;
}
