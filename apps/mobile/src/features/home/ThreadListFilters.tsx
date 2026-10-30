import type { EnvironmentId } from "@d4research/contracts";
import { Pressable, ScrollView } from "react-native";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText } from "../../components/ui/AppText";
import type { HomeListFilterMenuEnvironment } from "./home-list-filter-menu";
import { findHomeProjectScope, type HomeProjectScope } from "./homeThreadList";
import type { ProjectNavigationMode } from "./ProjectNavigationPanel";

export function ThreadListFilters(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeProjectScope>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onOpen: (mode: ProjectNavigationMode) => void;
  readonly onReset: () => void;
  readonly gutter: number;
}) {
  const environment = props.environments.find(
    (item) => item.environmentId === props.selectedEnvironmentId,
  );
  const scope = findHomeProjectScope(props.projects, props.selectedProjectKey);
  const project = scope?.representative;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ marginHorizontal: -props.gutter }}
      contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 2, paddingBottom: 10, gap: 8 }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Choose environment"
        onPress={() => props.onOpen("environments")}
        className="min-h-11 flex-row items-center gap-2 rounded-xl border border-border bg-input px-3"
      >
        <SymbolView name="desktopcomputer" size={15} tintColorClassName="accent-foreground-muted" />
        <AppText className="text-sm" numberOfLines={1}>
          {environment?.label ?? "All environments"}
        </AppText>
        <SymbolView name="chevron.down" size={10} tintColorClassName="accent-foreground-muted" />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Choose project"
        accessibilityHint="You can also swipe right from the left edge"
        onPress={() => props.onOpen("projects")}
        className="min-h-11 flex-row items-center gap-2 rounded-xl border border-border bg-input px-3"
      >
        {project && scope ? (
          <ProjectFavicon
            environmentId={project.environmentId}
            projectTitle={scope.title}
            workspaceRoot={project.workspaceRoot}
            faviconPath={project.faviconPath}
            projectIcon={project.projectIcon}
            size={20}
          />
        ) : (
          <SymbolView name="sidebar.left" size={16} tintColorClassName="accent-foreground-muted" />
        )}
        <AppText className="text-sm" numberOfLines={1}>
          {scope?.title ?? "All projects"}
        </AppText>
      </Pressable>
      {props.selectedEnvironmentId !== null || props.selectedProjectKey !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset thread filters"
          onPress={props.onReset}
          className="min-h-11 min-w-11 items-center justify-center"
        >
          <SymbolView
            name="xmark.circle.fill"
            size={18}
            tintColorClassName="accent-foreground-muted"
          />
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
