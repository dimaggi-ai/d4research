import { PermissionUpdateNotice } from "./features/connection/PermissionUpdateNotice";
import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  createStaticNavigation,
  getStateFromPath,
  type NavigationState,
} from "@react-navigation/native";

import { RegistryContext } from "@effect/atom-react";
import { ThreadArrangementHost } from "./features/threads/ThreadArrangementSheet";
import * as Dialog from "./components/ui/Dialog";
import { prepareNativeShowcaseCapture } from "./features/showcase/nativeShowcaseScene";
import {
  startIncomingShareInbox,
  presentPendingIncomingShare,
  pruneIncomingShareImports,
} from "./features/sharing/IncomingShareProvider";
import { installThreadOutboxDelivery } from "./state/threadOutboxDelivery";
import { installComposerAttachmentUploads } from "./state/composer-attachment-uploads";
import { installAppearanceRuntime } from "./features/settings/appearance/AppearancePreferencesProvider";
import {
  attachRootNavigation,
  rootNavigationRef,
  flushRootNavigationQueue,
} from "./lib/rootNavigation";
import {
  recordWorkspaceSelections,
  hydrateWorkspaceSelections,
  settingsLinkPage,
} from "./features/workspace/workspace-selection-store";
import { restoreSettingsLinkState } from "./features/settings/settings-navigation";
import { pruneNewTaskFlowStates } from "./features/threads/new-task-flow-state";
import { pruneNewTaskBranchCheckouts } from "./features/threads/NewTaskDraftRouteScreen";
import { subscribeComposerDraftModelReconciliation } from "./state/use-composer-drafts";
import { environmentThreadShells } from "./state/threads";
import { environmentShell } from "./state/shell";
import { ProjectChipIconRasterizer } from "./native/ProjectChipIconImages";
import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from "./features/settings/appearance/AppearancePreferencesProvider";
import { RootStack } from "./Stack";
import { appAtomRegistry } from "./state/atom-registry";
import { OverlayPortalHost } from "./components/ui/OverlayPortal";
import { shouldHandleAppLink, restoreDraftLinkState } from "./lib/appLinking";
import { useMobileNavigationTheme } from "./lib/useMobileNavigationTheme";
import { useUiRuntimeMemoryWarningGc } from "./lib/useUiRuntimeMemoryWarningGc";
import { SubscriptionUsageCoordinator } from "./widgets/SubscriptionUsageCoordinator";
import { GlobalVoiceInputControl } from "./features/voice-input/GlobalVoiceInputControl";
import { NativeLayoutMetricsProvider } from "./native/native-layout-metrics";

import "../global.css";

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  prepareNativeShowcaseCapture();
}

void SplashScreen.preventAutoHideAsync().catch(() => {});

const appLinking = {
  prefixes: [Linking.createURL("/"), "t3code://", "t3code-dev://", "t3code-preview://"],
  config: { initialRouteName: "Home" },
  filter: shouldHandleAppLink,
  getStateFromPath: (path: string, options: Parameters<typeof getStateFromPath>[1]) =>
    restoreSettingsLinkState(
      restoreDraftLinkState(getStateFromPath(path, options), path),
      settingsLinkPage(),
    ),
};

const Navigation = createStaticNavigation(RootStack);

function handleNavigationStateChange(state: NavigationState | undefined) {
  recordWorkspaceSelections(state);
  presentPendingIncomingShare();
  if (!state) return;
  pruneNewTaskFlowStates(state);
  pruneNewTaskBranchCheckouts(state);
  pruneIncomingShareImports(state);
}

function SplashScreenCoordinator() {
  const { isReady } = useAppearancePreferences();

  useEffect(() => {
    if (isReady) void SplashScreen.hide();
  }, [isReady]);

  return null;
}

export default function App() {
  useUiRuntimeMemoryWarningGc();
  useEffect(() => {
    void hydrateWorkspaceSelections();
    const cleanup = [
      subscribeComposerDraftModelReconciliation({
        registry: appAtomRegistry,
        threadShellAtom: environmentThreadShells.threadShellAtom,
        threadRefsAtom: environmentThreadShells.threadRefsAtom,
        shellStateAtom: environmentShell.stateAtom,
      }),
      startIncomingShareInbox(),
      installThreadOutboxDelivery(),
      installComposerAttachmentUploads(),
      installAppearanceRuntime(),
    ];
    return () => cleanup.forEach((dispose) => dispose());
  }, []);

  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <AppearancePreferencesProvider>
        <AppContent />
      </AppearancePreferencesProvider>
    </RegistryContext.Provider>
  );
}

function AppContent() {
  const { themeAppearance } = useAppearancePreferences();
  const navigationTheme = useMobileNavigationTheme();

  return (
    <>
      <SplashScreenCoordinator />
      <SubscriptionUsageCoordinator />
      <PermissionUpdateNotice />
      <GestureHandlerRootView className="flex-1">
        <KeyboardProvider statusBarTranslucent>
          <SafeAreaProvider>
            <StatusBar barStyle={themeAppearance === "dark" ? "light-content" : "dark-content"} />
            {/* The navigation theme drives the NATIVE header appearance: native-stack
                forwards `dark` as the nav bar's overrideUserInterfaceStyle. Without
                this, React Navigation defaults to its light theme and every native
                header (glass buttons, title, materials) is forced light even when
                the system is in dark mode. */}
            <GlobalVoiceInputControl>
              <NativeLayoutMetricsProvider>
                <Navigation
                  ref={attachRootNavigation}
                  onReady={() => {
                    handleNavigationStateChange(rootNavigationRef.getRootState());
                    flushRootNavigationQueue();
                  }}
                  onStateChange={handleNavigationStateChange}
                  linking={appLinking}
                  theme={navigationTheme}
                />

                <Dialog.Host />
                <ThreadArrangementHost />
                <ProjectChipIconRasterizer />
              </NativeLayoutMetricsProvider>
            </GlobalVoiceInputControl>
            {/* Anchored-menu overlays render here — in-window, so the
                keyboard stays up while a dropdown is open. */}
            <OverlayPortalHost />
          </SafeAreaProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </>
  );
}
