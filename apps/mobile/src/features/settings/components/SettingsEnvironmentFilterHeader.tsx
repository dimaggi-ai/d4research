import type { NativeStackHeaderItem } from "@react-navigation/native-stack";
import { Platform, Pressable } from "react-native";
import { Menu } from "../../../components/ui/Menu";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { withNativeGlassHeaderItem } from "../../layout/native-glass-header-items";
import { resolveEnvironmentMachineKind } from "@d4research/contracts";

import type { AppBarMenu } from "../../../components/ui/AppBar.types";
import { ENVIRONMENT_MACHINE_SYMBOLS } from "../../../components/EnvironmentMachineSymbol";
import { useSettingsEnvironmentFilter } from "../settings-environment-filter";

/** The settings scope filter, as an `AppBar` menu. */
export function useSettingsEnvironmentMenu(): AppBarMenu {
  const {
    availableTargets,
    selectedTargets,
    selectedIds,
    selectAll,
    toggleEnvironment,
    selectableProjectGroups,
    selectedProjectKey,
    selectProject,
  } = useSettingsEnvironmentFilter();
  return {
    title: "Filter settings environments and projects",
    icon:
      selectedIds === null && selectedProjectKey === null
        ? "line.3.horizontal.decrease"
        : "line.3.horizontal.decrease.circle.fill",
    items: [
      {
        id: "environments",
        title:
          selectedIds === null
            ? "All environments"
            : `${selectedTargets.length} ${selectedTargets.length === 1 ? "environment" : "environments"}`,
        items: [
          {
            id: "all",
            title: "All connected environments",
            selected: selectedIds === null,
            onPress: selectAll,
          },
          ...availableTargets.map((entry) => ({
            id: `environment:${entry.environmentId}`,
            title: entry.label,
            icon: ENVIRONMENT_MACHINE_SYMBOLS[resolveEnvironmentMachineKind(entry.serverConfig)],
            subtitle: entry.displayUrl ?? undefined,
            selected: selectedIds === null || selectedIds.has(entry.environmentId),
            onPress: () => toggleEnvironment(entry.environmentId),
          })),
        ],
      },
      {
        id: "projects",
        title:
          selectableProjectGroups.find((group) => group.key === selectedProjectKey)?.label ??
          (selectedProjectKey === null ? "All projects" : "Unavailable project"),
        items: [
          {
            id: "project:all",
            title: "All projects",
            selected: selectedProjectKey === null,
            onPress: () => selectProject(null),
          },
          ...selectableProjectGroups.map((group) => ({
            id: `project:${group.key}`,
            title: projectMenuLabel(group),
            selected: selectedProjectKey === group.key,
            onPress: () => selectProject(group.key),
          })),
        ],
      },
    ],
  };
}

const projectMenuLabel = (group: { readonly label: string; readonly archived: boolean }) =>
  group.archived ? `${group.label} · Archived` : group.label;

export function SettingsEnvironmentFilterHeader(props: {
  readonly trailingItems?: readonly NativeStackHeaderItem[];
}) {
  const {
    availableTargets,
    selectedTargets,
    selectedIds,
    selectAll,
    toggleEnvironment,
    selectableProjectGroups,
    selectedProjectKey,
    selectProject,
  } = useSettingsEnvironmentFilter();
  if (Platform.OS !== "ios") return null;

  const filterIcon =
    selectedIds === null && selectedProjectKey === null
      ? "line.3.horizontal.decrease"
      : "line.3.horizontal.decrease.circle.fill";
  const filterVersion = JSON.stringify({
    selection: selectedIds === null ? null : [...selectedIds].sort(),
    targets: availableTargets.map((entry) => [
      entry.environmentId,
      entry.label,
      entry.displayUrl,
      resolveEnvironmentMachineKind(entry.serverConfig),
    ]),
    project: selectedProjectKey,
    projects: selectableProjectGroups.map((group) => [group.key, group.label]),
    trailingItems: props.trailingItems,
  });

  return (
    <NativeStackScreenOptions
      optionsVersion={filterVersion}
      options={{
        unstable_headerRightItems: () => [
          withNativeGlassHeaderItem({
            axisBehavior: "horizontalOnly",
            accessibilityLabel: "Filter settings environments and projects",
            icon: { name: filterIcon, type: "sfSymbol" },
            label: "",
            type: "menu",
            menu: {
              title: "Settings scope",
              items: [
                {
                  type: "submenu",
                  label:
                    selectedIds === null
                      ? "All environments"
                      : `${selectedTargets.length} ${selectedTargets.length === 1 ? "environment" : "environments"}`,
                  items: [
                    {
                      type: "action",
                      label: "All connected environments",
                      state: selectedIds === null ? "on" : undefined,
                      onPress: selectAll,
                    },
                    ...availableTargets.map((entry) => ({
                      type: "action" as const,
                      label: entry.label,
                      icon: {
                        type: "sfSymbol" as const,
                        name: ENVIRONMENT_MACHINE_SYMBOLS[
                          resolveEnvironmentMachineKind(entry.serverConfig)
                        ],
                      },
                      description: entry.displayUrl ?? undefined,
                      state:
                        selectedIds === null || selectedIds.has(entry.environmentId)
                          ? ("on" as const)
                          : undefined,
                      onPress: () => toggleEnvironment(entry.environmentId),
                    })),
                  ],
                },
                {
                  type: "submenu",
                  label:
                    selectableProjectGroups.find((group) => group.key === selectedProjectKey)
                      ?.label ??
                    (selectedProjectKey === null ? "All projects" : "Unavailable project"),
                  items: [
                    {
                      type: "action",
                      label: "All projects",
                      state: selectedProjectKey === null ? "on" : undefined,
                      onPress: () => selectProject(null),
                    },
                    ...selectableProjectGroups.map((group) => ({
                      type: "action" as const,
                      label: projectMenuLabel(group),
                      state: selectedProjectKey === group.key ? ("on" as const) : undefined,
                      onPress: () => selectProject(group.key),
                    })),
                  ],
                },
              ],
            },
          }),
          ...(props.trailingItems ?? []),
        ],
      }}
    />
  );
}

export function AndroidSettingsEnvironmentFilter() {
  const {
    availableTargets,
    selectedIds,
    selectAll,
    toggleEnvironment,
    selectableProjectGroups,
    selectedProjectKey,
    selectProject,
  } = useSettingsEnvironmentFilter();
  const filterIcon =
    selectedIds === null && selectedProjectKey === null
      ? "line.3.horizontal.decrease"
      : "line.3.horizontal.decrease.circle.fill";

  return (
    <Menu
      accessible
      accessibilityRole="button"
      accessibilityLabel="Filter settings environments and projects"
      title="Settings scope"
      actions={[
        {
          id: "all",
          title: "All connected environments",
          state: selectedIds === null ? ("on" as const) : ("off" as const),
        },
        ...availableTargets.map((entry) => ({
          id: `environment:${entry.environmentId}`,
          title: `Environment · ${entry.label}`,
          image: ENVIRONMENT_MACHINE_SYMBOLS[resolveEnvironmentMachineKind(entry.serverConfig)],
          subtitle: entry.displayUrl ?? undefined,
          state:
            selectedIds === null || selectedIds.has(entry.environmentId)
              ? ("on" as const)
              : ("off" as const),
        })),
        {
          id: "project:all",
          title: "All projects",
          state: selectedProjectKey === null ? ("on" as const) : ("off" as const),
        },
        ...selectableProjectGroups.map((group) => ({
          id: `project:${group.key}`,
          title: `Project · ${projectMenuLabel(group)}`,
          state: selectedProjectKey === group.key ? ("on" as const) : ("off" as const),
        })),
      ]}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "all") selectAll();
        else if (nativeEvent.event === "project:all") selectProject(null);
        else if (nativeEvent.event.startsWith("project:")) {
          const group = selectableProjectGroups.find(
            (entry) => `project:${entry.key}` === nativeEvent.event,
          );
          if (group) selectProject(group.key);
        } else {
          const target = availableTargets.find(
            (entry) => `environment:${entry.environmentId}` === nativeEvent.event,
          );
          if (target) toggleEnvironment(target.environmentId);
        }
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Filter settings environments and projects"
        className="size-11 items-center justify-center rounded-full"
      >
        <SymbolView name={filterIcon} size={22} tintColorClassName="accent-icon" />
      </Pressable>
    </Menu>
  );
}
