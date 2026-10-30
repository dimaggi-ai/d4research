import type { ProjectEntry } from "@d4research/contracts";
import { isAbsolutePath, isWindowsAbsolutePath, isHostPath } from "@d4research/shared/path";

export interface FileBreadcrumb {
  label: string;
  path: string;
  kind: "project" | "directory" | "file";
}

export interface FileBreadcrumbChild extends ProjectEntry {
  label: string;
}

export function fileBreadcrumbs(projectName: string, relativePath: string): FileBreadcrumb[] {
  const hostPath = isHostPath(relativePath);
  const separator = isWindowsAbsolutePath(relativePath) ? "\\" : "/";
  const parts = relativePath.split(/[\\/]/).filter(Boolean);
  const root = relativePath.startsWith("\\\\") ? "\\\\" : relativePath.startsWith("/") ? "/" : "";
  return [
    ...(hostPath ? [] : [{ label: projectName, path: "", kind: "project" as const }]),
    ...parts.map((part, index) => {
      const path = root + parts.slice(0, index + 1).join(separator);
      return {
        label: part,
        // A bare drive (`C:`) means the drive's current directory; its root is `C:\`.
        // A bare `~` is not a host path; the home folder is `~/`.
        path: /^[A-Za-z]:$/.test(path) ? `${path}\\` : hostPath && path === "~" ? "~/" : path,
        kind: index === parts.length - 1 ? ("file" as const) : ("directory" as const),
      };
    }),
  ];
}

/** Use the crumb's path spelling so trailing or repeated separators still match. */
export function breadcrumbPathOf(relativePath: string): string {
  return fileBreadcrumbs("", relativePath).at(-1)?.path ?? relativePath;
}

/** UNC servers are not listable directories; their shares are. */
export function isListableHostFolder(path: string): boolean {
  return isHostPath(path) && !/^\\\\[^\\/]+$/.test(path);
}

function trailCrumbIndex(trail: string, path: string): number {
  const crumbPath = breadcrumbPathOf(path);
  return fileBreadcrumbs("", trail).findIndex((crumb) => crumb.path === crumbPath);
}

/** Retain descendant crumbs when navigating up; other navigation resets the trail to path. */
export function retainedBreadcrumbTrail(trail: string | undefined, path: string): string {
  return trail !== undefined && trailCrumbIndex(trail, path) >= 0 ? trail : path;
}

export function trailChildOf(folder: string, trail: string): string | null {
  const index = trailCrumbIndex(trail, folder);
  return index < 0 ? null : (fileBreadcrumbs("", trail)[index + 1]?.label ?? null);
}

export function joinHostPath(folder: string, relativePath: string): string {
  const separator = isWindowsAbsolutePath(folder) ? "\\" : "/";
  const base = folder.endsWith(separator) ? folder : `${folder}${separator}`;
  return base + relativePath.split("/").join(separator);
}

export function fileBreadcrumbChildren(
  entries: readonly ProjectEntry[],
  directoryPath: string,
): FileBreadcrumbChild[] {
  let collator: Intl.Collator | undefined;
  const prefix = directoryPath ? `${directoryPath}/` : "";
  return entries
    .flatMap((entry) => {
      if (!entry.path.startsWith(prefix)) return [];
      const label = entry.path.slice(prefix.length);
      if (!label || label.includes("/")) return [];
      return [{ ...entry, label }];
    })
    .toSorted((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      collator ??= new Intl.Collator(undefined, {
        numeric: true,
        sensitivity: "base",
      });
      return collator.compare(left.label, right.label);
    });
}

export function fileBreadcrumbParent(directoryPath: string): string | null {
  if (!directoryPath) return null;
  const separatorIndex = directoryPath.lastIndexOf("/");
  return separatorIndex === -1 ? "" : directoryPath.slice(0, separatorIndex);
}

const pathParts = (path: string): string[] => path.split("/").filter(Boolean);

export function parentDirectoryPath(relativePath: string): string {
  const parts = pathParts(relativePath);
  return parts.slice(0, -1).join("/");
}

export function workspaceDocumentDirectory(workspaceRoot: string, relativePath: string): string {
  if (isAbsolutePath(relativePath)) {
    const separator = Math.max(relativePath.lastIndexOf("/"), relativePath.lastIndexOf("\\"));
    if (separator === 0) return "/";
    if (separator === 2 && /^[A-Za-z]:/.test(relativePath)) return relativePath.slice(0, 3);
    return relativePath.slice(0, separator);
  }
  const parent = parentDirectoryPath(relativePath);
  if (!parent) return workspaceRoot.replace(/[\\/]+$/, "") || workspaceRoot;
  const separator = workspaceRoot.includes("\\") && !workspaceRoot.includes("/") ? "\\" : "/";
  return `${workspaceRoot.replace(/[\\/]+$/, "")}${separator}${parent.replaceAll("/", separator)}`;
}

export function directChildProjectEntries(
  entries: ReadonlyArray<ProjectEntry>,
  directoryPath: string,
): ProjectEntry[] {
  const directoryParts = pathParts(directoryPath);
  return entries
    .filter((entry) => {
      const entryParts = pathParts(entry.path);
      if (entryParts.length !== directoryParts.length + 1) {
        return false;
      }
      return directoryParts.every((part, index) => entryParts[index] === part);
    })
    .toSorted((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === "directory" ? -1 : 1;
      }
      return left.path.localeCompare(right.path, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    });
}

export function firstFileInDirectory(
  entries: ReadonlyArray<ProjectEntry>,
  directoryPath: string,
): string | null {
  const directoryParts = pathParts(directoryPath);
  return (
    entries
      .filter((entry) => {
        if (entry.kind !== "file") {
          return false;
        }
        const entryParts = pathParts(entry.path);
        if (entryParts.length <= directoryParts.length) {
          return false;
        }
        return directoryParts.every((part, index) => entryParts[index] === part);
      })
      .toSorted((left, right) =>
        left.path.localeCompare(right.path, undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      )[0]?.path ?? null
  );
}
