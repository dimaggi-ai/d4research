import { formatWorkspaceRelativePath } from "./filePathDisplay";
import {
  isTerminalLinkActivation,
  resolvePathLinkTarget,
  splitPathAndPosition,
} from "./terminal-links";

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\/;
const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;
const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;
const RELATIVE_FILE_PATH_PATTERN =
  /^(?:[A-Za-z0-9._-]+(?: +[A-Za-z0-9._-]+)*\/)+[A-Za-z0-9._-]+(?: +[A-Za-z0-9._-]+)*(?::\d+){0,2}$/;
const RELATIVE_FILE_NAME_PATTERN =
  /^[A-Za-z0-9._-]+(?: +[A-Za-z0-9._-]+)*\.[A-Za-z0-9_-]+(?::\d+){0,2}$/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;
// Standard OS and dev-container roots; deliberately excludes app-route-ish
// prefixes like /app/ or /chat/ so SPA routes never read as files.
const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/lib/",
  "/lib64/",
  "/srv/",
  "/dev/",
  "/proc/",
  "/sys/",
  "/run/",
  "/boot/",
  "/media/",
  "/workspace/",
  "/workspaces/",
] as const;
const MARKDOWN_LINK_HREF_PATTERN =
  /\[[^\]]*]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;

export interface MarkdownFileLinkMeta {
  filePath: string;
  workspaceLookupPath: string | null;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  /** Explicit absolute references must not be reinterpreted as project-directory aliases. */
  absoluteReference?: boolean;
  basename: string;
  line?: number;
  column?: number;
}

export interface MarkdownWorkspaceRootCandidate {
  path: string;
  label?: string | undefined;
}

export interface MarkdownFilePanelTarget {
  path: string;
  workspaceRoot?: string | undefined;
}

export function extractMarkdownLinkHrefs(markdown: string): string[] {
  const hrefs: string[] = [];
  for (const match of markdown.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = (match[1] ?? match[2])?.trim();
    if (href) hrefs.push(href);
  }
  return hrefs;
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

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function isWindowsDrivePathHref(href: string): boolean {
  return WINDOWS_DRIVE_PATH_PATTERN.test(safeDecode(href));
}

function unwrapMarkdownLinkDestination(value: string): string {
  return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
}

function normalizeMarkdownLinkDestination(value: string): string {
  return unwrapMarkdownLinkDestination(value.trim());
}

function stripSearchAndHash(value: string): { path: string; hash: string } {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const rawHash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = pathWithSearch.indexOf("?");
  const path = queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch;
  return { path, hash: rawHash };
}

function normalizeWindowsDrivePath(path: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

function parseFileUrlHref(
  href: string,
  options?: { readonly decodePath?: boolean },
): { path: string; hash: string } | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") return null;

    const uncHostname = parsed.hostname.toLowerCase() === "localhost" ? "" : parsed.hostname;
    const rawPath = uncHostname
      ? `\\\\${uncHostname}${parsed.pathname.replaceAll("/", "\\")}`
      : parsed.pathname;
    if (rawPath.length === 0) return null;

    // Browser URL parser encodes "C:/foo" as "/C:/foo" for file URLs.
    const normalizedPath = normalizeWindowsDrivePath(rawPath);

    return {
      path: options?.decodePath === false ? normalizedPath : safeDecode(normalizedPath),
      hash: parsed.hash,
    };
  } catch {
    return null;
  }
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const target = parseFileUrlHref(normalizedHref, { decodePath: false });
  if (!target) return null;
  return `${target.path}${target.hash}`;
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function appendLineColumnFromHash(path: string, hash: string): string {
  if (!hash || POSITION_SUFFIX_PATTERN.test(path)) return path;
  const match = hash.match(/^#L(\d+)(?:C(\d+))?$/i);
  if (!match?.[1]) return path;
  const line = match[1];
  const column = match[2];
  return `${path}:${line}${column ? `:${column}` : ""}`;
}

function isLikelyPathCandidate(path: string): boolean {
  if (WINDOWS_DRIVE_PATH_PATTERN.test(path) || WINDOWS_UNC_PATH_PATTERN.test(path)) return true;
  if (RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (path.startsWith("/")) return looksLikePosixFilesystemPath(path);
  return RELATIVE_FILE_PATH_PATTERN.test(path) || RELATIVE_FILE_NAME_PATTERN.test(path);
}

function isRelativePath(path: string): boolean {
  return (
    RELATIVE_PATH_PREFIX_PATTERN.test(path) ||
    (!path.startsWith("/") &&
      !WINDOWS_DRIVE_PATH_PATTERN.test(path) &&
      !WINDOWS_UNC_PATH_PATTERN.test(path))
  );
}

function hasExternalScheme(path: string): boolean {
  const match = path.match(EXTERNAL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = match[2] ?? "";
  if (rest.startsWith("//")) return true;
  return !POSITION_ONLY_PATTERN.test(rest);
}

function normalizeResolvedFileTarget(targetPath: string): string {
  const { path, line, column } = splitPathAndPosition(targetPath);
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

export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): string | null {
  if (!href) return null;
  const rawHref = normalizeMarkdownLinkDestination(href);
  if (rawHref.length === 0 || rawHref.startsWith("#") || rawHref.startsWith("//")) return null;

  const fileUrlTarget = rawHref.toLowerCase().startsWith("file:")
    ? parseFileUrlHref(rawHref)
    : null;
  const source = fileUrlTarget ?? stripSearchAndHash(rawHref);
  const decodedPath = normalizeWindowsDrivePath(
    fileUrlTarget ? source.path.trim() : safeDecode(source.path.trim()),
  );
  const decodedHash = safeDecode(source.hash.trim());

  if (decodedPath.length === 0) return null;
  if (
    !WINDOWS_DRIVE_PATH_PATTERN.test(decodedPath) &&
    !WINDOWS_UNC_PATH_PATTERN.test(decodedPath) &&
    hasExternalScheme(decodedPath)
  ) {
    return null;
  }

  if (!isLikelyPathCandidate(decodedPath)) return null;

  const pathWithPosition = appendLineColumnFromHash(decodedPath, decodedHash);
  if (!isRelativePath(pathWithPosition)) {
    return normalizeResolvedFileTarget(pathWithPosition);
  }

  if (!baseDir) return null;
  return normalizeResolvedFileTarget(resolvePathLinkTarget(pathWithPosition, baseDir));
}

const INLINE_CODE_DISQUALIFIER_PATTERN = /[\s`]/;
const PATH_SEPARATOR_PATTERN = /[\\/]/;
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9_-]+$/;
const NUMERIC_DOTTED_PATTERN = /^\d+(?:\.\d+)+$/;
const BARE_EXTENSIONLESS_POSITION_PATTERN = /^[A-Za-z0-9_-]+(?::\d+){1,2}$/;
// Any `Name:digits` shape also matches `error:1`, `port:3000`, `label:12`, so
// extensionless linking is limited to conventional filenames.
const EXTENSIONLESS_FILE_NAMES = new Set([
  "Makefile",
  "makefile",
  "GNUmakefile",
  "Dockerfile",
  "Containerfile",
  "Justfile",
  "justfile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "Brewfile",
  "Caddyfile",
  "Vagrantfile",
  "Jenkinsfile",
  "Podfile",
  "Fastfile",
  "BUILD",
  "WORKSPACE",
  "LICENSE",
  "LICENCE",
  "COPYING",
  "NOTICE",
  "AUTHORS",
  "CONTRIBUTORS",
  "CHANGELOG",
  "README",
  "CODEOWNERS",
]);
const SINGLE_LABEL_HOSTNAMES = new Set(["localhost"]);
// Allowlists, not full public-suffix detection: treating every dotted first
// segment as a host would swallow real paths like `conf.d/x.conf` or
// `Makefile.in:12`. Extensions that double as filename suffixes (`sh`, `md`,
// `ts`, `rs`, `in`, ...) are deliberately absent from both sets.
const GENERIC_HOSTNAME_TLDS = new Set([
  "com",
  "net",
  "org",
  "io",
  "dev",
  "app",
  "ai",
  "co",
  "edu",
  "gov",
  "mil",
  "info",
  "biz",
  "xyz",
  "me",
  "tv",
  "cc",
  "gg",
  "chat",
  "cloud",
  "site",
  "online",
  "tech",
  "store",
  "link",
]);
// Country codes collide with file extensions (`.pl` Perl, `.pt` PyTorch,
// `.es` ES modules), so they only count as host evidence when the candidate
// lacks a :line suffix — an explicit line reference marks a file and wins.
const COUNTRY_HOSTNAME_TLDS = new Set([
  "uk",
  "de",
  "fr",
  "nl",
  "se",
  "no",
  "fi",
  "dk",
  "pl",
  "ch",
  "at",
  "be",
  "es",
  "it",
  "pt",
  "eu",
  "us",
  "ca",
  "au",
  "nz",
  "jp",
  "kr",
  "cn",
  "br",
  "ru",
  "mx",
  "ie",
  "cz",
  "tr",
  "sg",
  "hk",
]);

/** `127.0.0.1`, `localhost`, `example.com`, `1.2.3` — hosts and versions, not files. */
function looksLikeHostname(segment: string, hasPosition: boolean): boolean {
  if (segment.startsWith(".")) return false;
  const lowered = segment.toLowerCase();
  if (SINGLE_LABEL_HOSTNAMES.has(lowered)) return true;
  if (NUMERIC_DOTTED_PATTERN.test(segment)) return true;
  const labels = lowered.split(".");
  const lastLabel = labels[labels.length - 1];
  if (labels.length < 2 || lastLabel === undefined) return false;
  if (GENERIC_HOSTNAME_TLDS.has(lastLabel)) return true;
  return !hasPosition && COUNTRY_HOSTNAME_TLDS.has(lastLabel);
}

export function resolveInlineCodeFileLinkMeta(
  codeText: string,
  cwd?: string,
  workspaceRoot: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const trimmed = codeText.trim();
  if (trimmed.length === 0 || INLINE_CODE_DISQUALIFIER_PATTERN.test(trimmed)) return null;

  // Windows drive/UNC paths keep their backslashes; any other backslashes are
  // relative Windows-style paths, which neither the shape checks nor the
  // downstream resolver understand — normalize them to forward slashes.
  const candidate =
    WINDOWS_DRIVE_PATH_PATTERN.test(trimmed) || WINDOWS_UNC_PATH_PATTERN.test(trimmed)
      ? trimmed
      : trimmed.replaceAll("\\", "/");

  const hasPosition = POSITION_SUFFIX_PATTERN.test(candidate);
  if (!hasPosition && !PATH_SEPARATOR_PATTERN.test(candidate)) return null;

  const hasExplicitPathShape =
    RELATIVE_PATH_PREFIX_PATTERN.test(candidate) ||
    candidate.startsWith("/") ||
    WINDOWS_DRIVE_PATH_PATTERN.test(candidate) ||
    WINDOWS_UNC_PATH_PATTERN.test(candidate);
  if (!hasExplicitPathShape) {
    const withoutPosition = candidate.replace(POSITION_SUFFIX_PATTERN, "");
    const firstSegment = withoutPosition.split("/")[0] ?? withoutPosition;
    if (looksLikeHostname(firstSegment, hasPosition)) return null;
    if (!hasPosition && !FILE_EXTENSION_PATTERN.test(basenameOfPath(withoutPosition))) {
      return null;
    }
  }

  const directories = resolveMarkdownLinkDirectories(cwd, workspaceRoot);
  // Repo-qualified inline paths use the repo root; explicit links and sibling
  // names still resolve from the document's directory, including host files.
  const inlineBase =
    directories.baseDir &&
    directories.workspaceRoot &&
    !RELATIVE_PATH_PREFIX_PATTERN.test(candidate) &&
    !candidate.startsWith("/") &&
    !WINDOWS_DRIVE_PATH_PATTERN.test(candidate) &&
    !WINDOWS_UNC_PATH_PATTERN.test(candidate) &&
    candidate.replace(POSITION_SUFFIX_PATTERN, "").includes("/") &&
    pathIsWithin(directories.baseDir, directories.workspaceRoot)
      ? directories.workspaceRoot
      : directories.baseDir;
  const resolved = resolveMarkdownFileLinkMeta(candidate, directories.workspaceRoot, inlineBase);
  if (resolved) return resolved;

  // `Makefile:12` — conventional extensionless names fail the generic
  // markdown-link candidate patterns, but here the :line suffix already
  // marked the span as a file reference.
  if (
    cwd &&
    BARE_EXTENSIONLESS_POSITION_PATTERN.test(candidate) &&
    EXTENSIONLESS_FILE_NAMES.has(candidate.replace(POSITION_SUFFIX_PATTERN, ""))
  ) {
    return buildFileLinkMetaFromTarget(
      resolvePathLinkTarget(candidate, directories.baseDir ?? cwd),
      directories.workspaceRoot,
    );
  }
  return null;
}

function basenameOfPath(path: string): string {
  // A trailing separator is a valid way to write a directory, so trim it before
  // taking the final segment. Without this the segment reads as empty and the
  // chip renders with no label at all.
  const trimmed = path.replace(/[/\\]+$/, "") || path;
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

function workspaceRelativePath(path: string, workspaceRoot: string | undefined): string | null {
  if (!workspaceRoot) return null;
  const normalizedPath = normalizeWindowsDrivePath(path.replaceAll("\\", "/"));
  const normalizedRoot = normalizeWindowsDrivePath(workspaceRoot.replaceAll("\\", "/")).replace(
    /\/+$/,
    "",
  );
  const pathForCompare = comparableWorkspacePath(normalizedPath);
  const rootForCompare = comparableWorkspacePath(normalizedRoot);
  if (pathForCompare === rootForCompare) return ".";
  if (!pathForCompare.startsWith(`${rootForCompare}/`)) return null;
  return normalizedPath.slice(normalizedRoot.length + 1);
}

function pathIsWithin(path: string, root: string): boolean {
  const normalizedPath = normalizeWindowsDrivePath(path.replaceAll("\\", "/")).replace(/\/+$/, "");
  const normalizedRoot = normalizeWindowsDrivePath(root.replaceAll("\\", "/")).replace(/\/+$/, "");
  const pathForCompare = comparableWorkspacePath(normalizedPath);
  const rootForCompare = comparableWorkspacePath(normalizedRoot);
  return pathForCompare === rootForCompare || pathForCompare.startsWith(`${rootForCompare}/`);
}

function comparableWorkspacePath(path: string): string {
  const normalized = normalizeWindowsDrivePath(path.replaceAll("\\", "/")).replace(/\/+$/, "");
  return WINDOWS_DRIVE_PATH_PATTERN.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
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
    const key = comparableWorkspacePath(root.path);
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
  const normalizedPanelPath = normalizeWindowsDrivePath(input.panelPath.replaceAll("\\", "/"))
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  const panelSegments = normalizedPanelPath.split("/").filter(Boolean);

  if (
    panelSegments.length > 1 &&
    !normalizedPanelPath.startsWith("/") &&
    !WINDOWS_DRIVE_PATH_PATTERN.test(normalizedPanelPath)
  ) {
    const prefix = panelSegments[0]!.toLowerCase();
    const aliasedRoot = roots.find((root) => {
      const aliases = [basenameOfPath(root.path), root.label]
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
    .filter((root) => pathIsWithin(input.filePath, root.path))
    .toSorted((left, right) => right.path.length - left.path.length)[0];
  if (owningRoot) {
    const relativePath = workspaceRelativePath(input.filePath, owningRoot.path);
    if (relativePath !== null) {
      return { path: relativePath, workspaceRoot: owningRoot.path };
    }
  }

  return { path: input.filePath };
}

/**
 * The third argument historically meant the workspace root in the fork, while
 * upstream uses it as the directory containing the rendered markdown file.
 * Infer which meaning the caller has from the paths so both call shapes keep
 * resolving links correctly during the transition.
 */
function resolveMarkdownLinkDirectories(
  cwd: string | undefined,
  alternateDirectory: string | undefined,
): { baseDir: string | undefined; workspaceRoot: string | undefined } {
  if (!alternateDirectory || !cwd) {
    return { baseDir: alternateDirectory ?? cwd, workspaceRoot: cwd };
  }
  if (pathIsWithin(cwd, alternateDirectory)) {
    return { baseDir: cwd, workspaceRoot: alternateDirectory };
  }
  return { baseDir: alternateDirectory, workspaceRoot: cwd };
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
  alternateDirectory: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const { baseDir, workspaceRoot } = resolveMarkdownLinkDirectories(cwd, alternateDirectory);
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd, baseDir);
  if (!targetPath) return null;
  const meta = buildFileLinkMetaFromTarget(targetPath, workspaceRoot);
  const source = safeDecode(normalizeMarkdownLinkDestination(href ?? ""));
  meta.workspaceLookupPath =
    isRelativePath(source) &&
    !source.startsWith("~") &&
    baseDir !== undefined &&
    workspaceRoot !== undefined &&
    comparableWorkspacePath(baseDir) === comparableWorkspacePath(workspaceRoot)
      ? stripSearchAndHash(source).path
      : null;
  if (
    source.startsWith("/") ||
    WINDOWS_DRIVE_PATH_PATTERN.test(source) ||
    WINDOWS_UNC_PATH_PATTERN.test(source) ||
    /^file:/i.test(source)
  ) {
    meta.absoluteReference = true;
  }
  return meta;
}

function buildFileLinkMetaFromTarget(
  targetPath: string,
  workspaceRoot?: string,
): MarkdownFileLinkMeta {
  const { path, line, column } = splitPathAndPosition(targetPath);
  const parsedLine = line ? Number.parseInt(line, 10) : Number.NaN;
  const parsedColumn = column ? Number.parseInt(column, 10) : Number.NaN;
  const lineNumber = Number.isFinite(parsedLine) ? parsedLine : undefined;
  const columnNumber = Number.isFinite(parsedColumn) ? parsedColumn : undefined;

  return {
    filePath: path,
    workspaceLookupPath: null,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, workspaceRoot),
    workspaceRelativePath: workspaceRelativePath(path, workspaceRoot),
    basename: basenameOfPath(path),
    ...(lineNumber !== undefined ? { line: lineNumber } : {}),
    ...(columnNumber !== undefined ? { column: columnNumber } : {}),
  };
}
