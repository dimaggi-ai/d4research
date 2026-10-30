import type { EnvironmentId } from "@d4research/contracts";
import { useEffect, useMemo, useState } from "react";
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReducedMotion } from "react-native-reanimated";

import { ProjectFavicon } from "../../components/ProjectFavicon";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText, AppTextInput } from "../../components/ui/AppText";
import type { HomeListFilterMenuEnvironment } from "./home-list-filter-menu";
import type { HomeProjectScope } from "./homeThreadList";

export type ProjectNavigationMode = "environments" | "projects";

export function ProjectNavigationPanel(props: {
  readonly mode: ProjectNavigationMode;
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeProjectScope>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const panelWidth = Math.min(width - 40, 370);
  const [query, setQuery] = useState("");
  const [translation] = useState(() => new Animated.Value(-panelWidth));
  const reduceMotion = useReducedMotion();
  const { onClose } = props;
  const dismissGesture = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          gesture.dx < -15 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 2,
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dx < -45 || gesture.vx < -0.5) onClose();
        },
      }),
    [onClose],
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Start and cancel the native slide animation with the mounted panel.
  useEffect(() => {
    const animation = Animated.timing(translation, {
      toValue: 0,
      duration: reduceMotion ? 0 : 180,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [reduceMotion, translation]);

  const selectEnvironment = (environmentId: EnvironmentId | null) => {
    props.onProjectChange(null);
    props.onEnvironmentChange(environmentId);
    if (props.mode === "environments") props.onClose();
  };
  const filteredProjects = props.projects.filter((scope) =>
    `${scope.title} ${scope.projects.map((project) => project.workspaceRoot).join(" ")}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()),
  );
  return (
    <Modal transparent animationType="fade" statusBarTranslucent onRequestClose={props.onClose}>
      <View className="flex-1">
        <Pressable
          className="absolute inset-0 bg-black/45"
          accessibilityLabel="Close project navigation"
          onPress={props.onClose}
        />
        <Animated.View
          accessibilityViewIsModal
          className="flex-1 border-r border-border bg-drawer"
          style={{
            width: panelWidth,
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
            transform: [{ translateX: translation }],
          }}
          {...dismissGesture.panHandlers}
        >
          <View className="flex-row items-center justify-between px-5 py-4">
            <AppText accessibilityRole="header" className="text-2xl font-t3-bold">
              {props.mode === "projects" ? "Projects" : "Environments"}
            </AppText>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close project navigation"
              onPress={props.onClose}
              hitSlop={12}
              className="min-h-11 min-w-11 items-center justify-center"
            >
              <SymbolView name="xmark" size={18} tintColorClassName="accent-foreground-muted" />
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 20 }}
          >
            <AppText className="mb-2 px-3 text-xs font-t3-bold uppercase text-foreground-muted">
              Environments
            </AppText>
            {[{ environmentId: null, label: "All environments" }, ...props.environments].map(
              (environment) => (
                <Pressable
                  key={environment.environmentId ?? "all"}
                  accessibilityRole="button"
                  accessibilityLabel={environment.label}
                  accessibilityState={{
                    selected: props.selectedEnvironmentId === environment.environmentId,
                  }}
                  onPress={() => selectEnvironment(environment.environmentId)}
                  className={`min-h-12 flex-row items-center gap-3 rounded-xl px-3 py-3 ${props.selectedEnvironmentId === environment.environmentId ? "bg-thread-selected" : ""}`}
                >
                  <SymbolView
                    name={environment.environmentId === null ? "globe" : "desktopcomputer"}
                    size={19}
                    tintColorClassName="accent-foreground-muted"
                  />
                  <AppText className="flex-1 text-base" numberOfLines={2}>
                    {environment.label}
                  </AppText>
                  {props.selectedEnvironmentId === environment.environmentId ? (
                    <SymbolView name="checkmark" size={16} tintColorClassName="accent-foreground" />
                  ) : null}
                </Pressable>
              ),
            )}
            {props.mode === "projects" ? (
              <>
                <AppTextInput
                  accessibilityLabel="Search projects"
                  placeholder="Find a project"
                  value={query}
                  onChangeText={setQuery}
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="mx-1 mt-5 mb-3"
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="All projects"
                  accessibilityState={{ selected: props.selectedProjectKey === null }}
                  onPress={() => {
                    props.onProjectChange(null);
                    props.onClose();
                  }}
                  className={`min-h-14 flex-row items-center gap-3 rounded-xl px-3 py-3 ${props.selectedProjectKey === null ? "bg-thread-selected" : ""}`}
                >
                  <SymbolView
                    name="square.grid.2x2"
                    size={24}
                    tintColorClassName="accent-foreground-muted"
                  />
                  <AppText className="flex-1 font-t3-medium">All projects</AppText>
                  {props.selectedProjectKey === null ? (
                    <SymbolView name="checkmark" size={16} tintColorClassName="accent-foreground" />
                  ) : null}
                </Pressable>
                {filteredProjects.map((scope) => {
                  const project = scope.representative;
                  const selected =
                    props.selectedProjectKey === scope.key ||
                    scope.projectRefs.some(
                      (ref) => `${ref.environmentId}:${ref.projectId}` === props.selectedProjectKey,
                    );
                  const environmentLabel = [
                    ...new Set(
                      scope.projectRefs
                        .map(
                          (ref) =>
                            props.environments.find(
                              (environment) => environment.environmentId === ref.environmentId,
                            )?.label,
                        )
                        .filter(Boolean),
                    ),
                  ].join(" · ");
                  return (
                    <Pressable
                      key={scope.key}
                      accessibilityRole="button"
                      accessibilityLabel={`${scope.title}, ${environmentLabel}`}
                      accessibilityState={{ selected }}
                      onPress={() => {
                        props.onProjectChange(scope.key);
                        props.onClose();
                      }}
                      className={`min-h-16 flex-row items-center gap-3 rounded-xl px-3 py-3 ${selected ? "bg-thread-selected" : ""}`}
                    >
                      <ProjectFavicon
                        environmentId={project.environmentId}
                        projectTitle={scope.title}
                        workspaceRoot={project.workspaceRoot}
                        faviconPath={project.faviconPath}
                        projectIcon={project.projectIcon}
                        size={30}
                      />
                      <View className="min-w-0 flex-1">
                        <AppText numberOfLines={1} className="font-t3-medium">
                          {scope.title}
                        </AppText>
                        <AppText numberOfLines={1} className="mt-0.5 text-xs text-foreground-muted">
                          {environmentLabel || project.workspaceRoot}
                        </AppText>
                      </View>
                      {selected ? (
                        <SymbolView
                          name="checkmark"
                          size={16}
                          tintColorClassName="accent-foreground"
                        />
                      ) : null}
                    </Pressable>
                  );
                })}
                {filteredProjects.length === 0 ? (
                  <AppText className="px-3 py-6 text-sm text-foreground-muted">
                    {query.trim() ? "No matching projects" : "No projects in this environment"}
                  </AppText>
                ) : null}
              </>
            ) : null}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
}

export function ProjectNavigationEdge(props: { readonly onOpen: () => void }) {
  const { onOpen } = props;
  const gesture = useMemo(
    () =>
      PanResponder.create({
        // Only the gutter owns this gesture, leaving row swipes and vertical scrolling alone.
        onMoveShouldSetPanResponder: (_event, state) =>
          state.dx > 12 && state.dx > Math.abs(state.dy) * 2,
        onPanResponderRelease: (_event, state) => {
          if (state.dx > 40 || state.vx > 0.5) onOpen();
        },
      }),
    [onOpen],
  );
  return (
    <View
      testID="project-navigation-edge"
      className="absolute top-0 bottom-0 left-0 w-5"
      {...gesture.panHandlers}
    />
  );
}
