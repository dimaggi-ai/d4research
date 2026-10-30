import type { ProjectWorkspace, ProjectWorkspaceColor } from "@d4research/contracts";

import { cn } from "~/lib/utils";

export const PROJECT_WORKSPACE_COLORS: ReadonlyArray<{
  color: ProjectWorkspaceColor;
  label: string;
  dotClassName: string;
  badgeClassName: string;
}> = [
  {
    color: "red",
    label: "Red",
    dotClassName: "bg-red-500",
    badgeClassName: "border-red-500/20 bg-red-500/12 text-red-700 dark:text-red-300",
  },
  {
    color: "orange",
    label: "Orange",
    dotClassName: "bg-orange-500",
    badgeClassName: "border-orange-500/20 bg-orange-500/12 text-orange-700 dark:text-orange-300",
  },
  {
    color: "amber",
    label: "Amber",
    dotClassName: "bg-amber-500",
    badgeClassName: "border-amber-500/20 bg-amber-500/12 text-amber-700 dark:text-amber-300",
  },
  {
    color: "green",
    label: "Green",
    dotClassName: "bg-green-500",
    badgeClassName: "border-green-500/20 bg-green-500/12 text-green-700 dark:text-green-300",
  },
  {
    color: "cyan",
    label: "Cyan",
    dotClassName: "bg-cyan-500",
    badgeClassName: "border-cyan-500/20 bg-cyan-500/12 text-cyan-700 dark:text-cyan-300",
  },
  {
    color: "blue",
    label: "Blue",
    dotClassName: "bg-blue-500",
    badgeClassName: "border-blue-500/20 bg-blue-500/12 text-blue-700 dark:text-blue-300",
  },
  {
    color: "violet",
    label: "Violet",
    dotClassName: "bg-violet-500",
    badgeClassName: "border-violet-500/20 bg-violet-500/12 text-violet-700 dark:text-violet-300",
  },
  {
    color: "pink",
    label: "Pink",
    dotClassName: "bg-pink-500",
    badgeClassName: "border-pink-500/20 bg-pink-500/12 text-pink-700 dark:text-pink-300",
  },
];

export function workspaceDirectoryName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) ?? path
  );
}

export function workspaceDisplayName(workspace: ProjectWorkspace, index: number): string {
  const label = workspace.label?.trim();
  if (label && label.toLowerCase() !== "primary directory") return label;
  return workspaceDirectoryName(workspace.path) || `Directory ${index + 1}`;
}

export function resolveWorkspaceColor(
  workspace: Pick<ProjectWorkspace, "color">,
  index: number,
): ProjectWorkspaceColor {
  return (
    workspace.color ?? PROJECT_WORKSPACE_COLORS[index % PROJECT_WORKSPACE_COLORS.length]!.color
  );
}

export function workspaceColorOption(color: ProjectWorkspaceColor) {
  return PROJECT_WORKSPACE_COLORS.find((option) => option.color === color)!;
}

export function workspaceBadgeClassName(color: ProjectWorkspaceColor, className?: string): string {
  return cn(
    "border shadow-xs/5 transition-colors hover:brightness-110",
    workspaceColorOption(color).badgeClassName,
    className,
  );
}
