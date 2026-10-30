import type { ContextMenuItem } from "@d4research/contracts";

import {
  RAIL_GROUP_COLORS,
  railGroupName,
  type RailGroup,
  type RailGroupColor,
} from "./projectRailGroups.logic";

const SWATCH_HEX: Record<RailGroupColor, string> = {
  gray: "#71717a",
  red: "#ef4444",
  orange: "#f97316",
  amber: "#f59e0b",
  green: "#22c55e",
  teal: "#14b8a6",
  sky: "#0ea5e9",
  blue: "#3b82f6",
  violet: "#8b5cf6",
  pink: "#ec4899",
};

export function railGroupSwatchHex(color: RailGroupColor): string {
  return SWATCH_HEX[color];
}

const capitalize = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export function buildRailProjectMenu(input: {
  readonly group: RailGroup | null;
  readonly groups: ReadonlyArray<RailGroup>;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly hasPath: boolean;
}): ContextMenuItem[] {
  const { group } = input;
  const otherGroups = input.groups.filter((candidate) => candidate.id !== group?.id);
  return [
    { id: "open", label: "Show threads" },
    ...(group ? [{ id: "group-scope", label: `Show threads from ${railGroupName(group)}` }] : []),
    {
      id: "group",
      label: group ? "Move to group" : "Add to group",
      separatorBefore: true,
      children: [
        { id: "group:new", label: "New group" },
        ...otherGroups.map((candidate, index) => ({
          id: `group:${candidate.id}`,
          label: railGroupName(candidate),
          colorSwatch: SWATCH_HEX[candidate.color],
          ...(index === 0 ? { separatorBefore: true } : {}),
        })),
      ],
    },
    ...(group ? [{ id: "remove-from-group", label: `Remove from ${railGroupName(group)}` }] : []),
    { id: "move-up", label: "Move up", disabled: !input.canMoveUp, separatorBefore: true },
    { id: "move-down", label: "Move down", disabled: !input.canMoveDown },
    ...(input.hasPath
      ? [{ id: "copy-path", label: "Copy path", icon: "copy", separatorBefore: true }]
      : []),
    {
      id: "project-settings",
      label: "Project settings",
      icon: "settings",
      ...(input.hasPath ? {} : { separatorBefore: true }),
    },
    { id: "settle-project", label: "Settle project", icon: "archive", separatorBefore: true },
  ];
}

function buildSettledProjectsMenu(
  projects: ReadonlyArray<{ readonly projectKey: string; readonly displayName: string }>,
): ContextMenuItem[] {
  return [
    { id: "header", label: "Settled projects", header: true },
    ...projects.map((project) => ({
      id: `open:${project.projectKey}`,
      label: project.displayName,
    })),
    {
      id: "unsettle",
      label: "Unsettle project",
      separatorBefore: true,
      children: projects.map((project) => ({
        id: `unsettle:${project.projectKey}`,
        label: project.displayName,
      })),
    },
  ];
}

export function buildRailGroupMenu(input: {
  readonly group: RailGroup;
  readonly summary: string;
  readonly isScoped: boolean;
  readonly addableProjects: ReadonlyArray<{ readonly key: string; readonly label: string }>;
  readonly hasOtherGroups: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}): ContextMenuItem[] {
  const { group } = input;
  return [
    { id: "header", label: `${railGroupName(group)} · ${input.summary}`, header: true },
    { id: "toggle", label: group.collapsed ? "Expand group" : "Collapse group" },
    {
      id: "scope",
      label: input.isScoped ? "Show all projects" : "Show threads from this group",
    },
    { id: "rename", label: "Rename group", icon: "pencil", separatorBefore: true },
    {
      id: "color",
      label: "Color",
      colorSwatch: SWATCH_HEX[group.color],
      children: RAIL_GROUP_COLORS.map((color) => ({
        id: `color:${color}`,
        label: capitalize(color),
        colorSwatch: SWATCH_HEX[color],
        checked: color === group.color,
      })),
    },
    {
      id: "add",
      label: "Add project",
      disabled: input.addableProjects.length === 0,
      children: input.addableProjects.map((project) => ({
        id: `add:${project.key}`,
        label: project.label,
      })),
    },
    {
      id: "collapse-others",
      label: "Collapse other groups",
      disabled: !input.hasOtherGroups,
      separatorBefore: true,
    },
    { id: "move-up", label: "Move group up", disabled: !input.canMoveUp },
    { id: "move-down", label: "Move group down", disabled: !input.canMoveDown },
    { id: "ungroup", label: "Ungroup", separatorBefore: true },
  ];
}

export function buildRailBackgroundMenu(input: {
  readonly named: boolean;
  readonly hasGroups: boolean;
  readonly settledProjects: ReadonlyArray<{
    readonly projectKey: string;
    readonly displayName: string;
  }>;
}): ContextMenuItem[] {
  return [
    { id: "new-group", label: "New group", icon: "folder-tree" },
    { id: "add-project", label: "Add project", icon: "folder" },
    {
      id: "settled-projects",
      label: "Settled projects",
      icon: "archive",
      disabled: input.settledProjects.length === 0,
      children: buildSettledProjectsMenu(input.settledProjects),
    },
    {
      id: "expand-all",
      label: "Expand all groups",
      disabled: !input.hasGroups,
      separatorBefore: true,
    },
    { id: "collapse-all", label: "Collapse all groups", disabled: !input.hasGroups },
    {
      id: "toggle-names",
      label: input.named ? "Hide names" : "Show names",
      separatorBefore: true,
    },
    { id: "hide-rail", label: "Hide project rail" },
  ];
}
