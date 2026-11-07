import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Keyboard, View } from "react-native";
import {
  CommonActions,
  type NavigationState,
  type PartialState,
  StackActions,
  useNavigation,
} from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";

import { useConnectionController } from "../connection/useConnectionController";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { MobileThemeId } from "../../lib/mobileTheme";
import { useProjects, useThreadShells } from "../../state/entities";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { holdEditingQueuedMessage } from "../../state/use-thread-outbox";
import { useWorkspaceState } from "../../state/workspace";
import {
  applyNativeShowcaseOrientation,
  getNativeShowcaseOrientation,
  getNativeShowcasePairingUrls,
  getNativeShowcaseScene,
  getNativeShowcaseTheme,
  markNativeShowcaseReady,
  type ShowcaseScene,
} from "./nativeShowcaseScene";
import {
  buildShowcasePendingTasks,
  SHOWCASE_PENDING_TASK_DEFINITIONS,
} from "./showcasePendingTasks";
import { buildShowcaseAgentActivity } from "./showcaseAgentActivity";
import { retryShowcaseOperation } from "./showcaseRetry";
import {
  clearShowcaseRenderSignal,
  getShowcaseRenderSignal,
  isShowcaseNativeContentReady,
  subscribeToShowcaseRenderSignal,
} from "./showcaseRenderSignal";
import { stageShowcaseAgentActivity } from "./stageShowcaseAgentActivity";

const SHOWCASE_ENABLED = process.env.EXPO_PUBLIC_SHOWCASE === "1";
const SHOWCASE_THREAD_ID = "remote-command-center";

type ShowcaseResetRoute = PartialState<NavigationState>["routes"][number];

function sceneFromPathname(pathname: string): ShowcaseScene | null {
  const routePath = pathname.split(/[?#]/u, 1)[0] ?? pathname;
  if (routePath === "/settings" || routePath.endsWith("/settings/environments")) {
    return "environments";
  }
  if (routePath.endsWith("/terminal")) return "terminal";
  if (routePath.endsWith("/review")) return "review";
  if (routePath.startsWith("/threads/")) return "thread";
  if (routePath === "/") return "threads";
  return null;
}

export function ShowcaseCaptureCoordinator(props: { readonly pathname: string }) {
  if (!SHOWCASE_ENABLED) return null;
  return <EnabledShowcaseCaptureCoordinator pathname={props.pathname} />;
}

function EnabledShowcaseCaptureCoordinator(props: { readonly pathname: string }) {
  const navigation = useNavigation();
  const { connectPairingUrl } = useConnectionController();
  const {
    isReady: appearancePreferencesReady,
    themeId,
    themeIds,
    setThemeIdForBothAppearances,
  } = useAppearancePreferences();
  const workspace = useWorkspaceState();
  const projects = useProjects();
  const threads = useThreadShells();
  const attemptedPairingRef = useRef(new Set<string>());
  const seededPendingTaskIdsRef = useRef(new Set<string>());
  const [pairingUrls, setPairingUrls] = useState<ReadonlyArray<string>>([]);
  const [pendingTasksReady, setPendingTasksReady] = useState(false);
  const [requestedScene, setRequestedScene] = useState<ShowcaseScene | null>(null);
  const [requestedTheme, setRequestedTheme] = useState<MobileThemeId | null>(null);
  const [themeRequestSettled, setThemeRequestSettled] = useState(false);
  const [requestedOrientation] = useState(getNativeShowcaseOrientation);
  const [orientationSettled, setOrientationSettled] = useState(requestedOrientation === null);
  const [agentActivityStaged, setAgentActivityStaged] = useState(false);
  const requestedSceneRef = useRef<ShowcaseScene | null>(null);
  // Staging reads the latest entities without restarting on every shell
  // update, which would re-enter a permission prompt that is still open.
  const entitiesRef = useRef({ threads, projects });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the showcase retry callback pointed at committed entities without restarting an open native permission prompt.
  useEffect(() => {
    entitiesRef.current = { threads, projects };
  }, [projects, threads]);
  const renderSignal = useSyncExternalStore(
    subscribeToShowcaseRenderSignal,
    getShowcaseRenderSignal,
    getShowcaseRenderSignal,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Poll the native capture harness launch arguments until its pairing URLs become available.
  useEffect(() => {
    if (pairingUrls.length > 0) return;

    const readLaunchRequest = () => {
      const values = getNativeShowcasePairingUrls();
      if (values.length === 0) return;
      setRequestedTheme(getNativeShowcaseTheme());
      setThemeRequestSettled(true);
      setPairingUrls(values);
    };
    readLaunchRequest();
    const interval = setInterval(readLaunchRequest, 250);
    return () => clearInterval(interval);
  }, [pairingUrls.length]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Apply the native capture harness orientation request and cancel retries when the coordinator unmounts.
  useEffect(() => {
    if (orientationSettled) return;
    if (requestedOrientation === null) return;

    let cancelled = false;
    void retryShowcaseOperation(async () => applyNativeShowcaseOrientation(requestedOrientation), {
      isCancelled: () => cancelled,
    }).then((applied) => {
      if (!cancelled && applied) setOrientationSettled(true);
    });
    return () => {
      cancelled = true;
    };
  }, [orientationSettled, requestedOrientation]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Poll the native capture harness for scene requests and invalidate the previous native draw signal.
  useEffect(() => {
    const readRequestedScene = () => {
      const value = getNativeShowcaseScene();
      if (!value || requestedSceneRef.current === value) return;
      requestedSceneRef.current = value;
      // A native draw belongs only to the scene request that produced it. In
      // particular, revisiting review must wait for its newly mounted surface.
      clearShowcaseRenderSignal();
      setAgentActivityStaged(false);
      setRequestedScene(value);
    };
    readRequestedScene();
    const interval = setInterval(readRequestedScene, 250);
    return () => clearInterval(interval);
  }, []);

  const themeApplied =
    requestedTheme === null
      ? themeRequestSettled
      : themeIds.light === requestedTheme && themeIds.dark === requestedTheme;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Apply the native capture harness theme request to the persisted appearance preferences once hydrated.
  useEffect(() => {
    if (requestedTheme === null || themeApplied || !appearancePreferencesReady) {
      return;
    }
    setThemeIdForBothAppearances(requestedTheme);
  }, [appearancePreferencesReady, requestedTheme, setThemeIdForBothAppearances, themeApplied]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Pair the remote showcase fixture environments requested by the native capture harness.
  useEffect(() => {
    if (pairingUrls.length === 0) return;
    let cancelled = false;
    void (async () => {
      await Promise.all(
        pairingUrls.map(async (pairingUrl) => {
          if (cancelled || attemptedPairingRef.current.has(pairingUrl)) return;
          const paired = await retryShowcaseOperation(
            async () => AsyncResult.isSuccess(await connectPairingUrl(pairingUrl)),
            { isCancelled: () => cancelled },
          );
          if (paired) attemptedPairingRef.current.add(pairingUrl);
        }),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [connectPairingUrl, pairingUrls]);

  const routeScene = sceneFromPathname(props.pathname);
  const scene =
    requestedScene === "agent-activity" && routeScene === "threads" ? "agent-activity" : routeScene;
  const hasServerFixture =
    workspace.state.hasReadyEnvironment &&
    workspace.environments.length >= 3 &&
    projects.length >= 3 &&
    threads.some((thread) => String(thread.id) === SHOWCASE_THREAD_ID);
  const hasFixture = hasServerFixture && pendingTasksReady;
  const showcaseThread = threads.find((thread) => String(thread.id) === SHOWCASE_THREAD_ID);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Seed the remote showcase outbox fixture after the paired server data has hydrated.
  useEffect(() => {
    if (!hasServerFixture || pendingTasksReady) return;

    const pendingTasks = buildShowcasePendingTasks(projects, Date.now());
    if (pendingTasks.length !== SHOWCASE_PENDING_TASK_DEFINITIONS.length) return;

    let cancelled = false;
    for (const task of pendingTasks) holdEditingQueuedMessage(task.messageId);
    void (async () => {
      const results = await Promise.all(
        pendingTasks.map(async (task) => {
          const messageId = String(task.messageId);
          if (seededPendingTaskIdsRef.current.has(messageId)) return true;
          const seeded = await retryShowcaseOperation(
            async () => {
              await enqueueThreadOutboxMessage(task);
              return true;
            },
            { isCancelled: () => cancelled },
          );
          if (seeded) seededPendingTaskIdsRef.current.add(messageId);
          return seeded;
        }),
      );
      if (!cancelled && results.every(Boolean)) setPendingTasksReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [hasServerFixture, pendingTasksReady, projects]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Navigate the native stack to the scene requested by the screenshot harness after fixture preparation.
  useEffect(() => {
    if (requestedScene === null || !hasFixture || !showcaseThread) return;
    if (scene === requestedScene) return;

    const params = {
      environmentId: String(showcaseThread.environmentId),
      threadId: SHOWCASE_THREAD_ID,
    };
    if (requestedScene === "threads") {
      navigation.dispatch(StackActions.popToTop());
      return;
    }
    if (requestedScene === "agent-activity") {
      navigation.dispatch(CommonActions.reset({ index: 0, routes: [{ name: "Home" }] }));
      return;
    }
    const routes: ShowcaseResetRoute[] = [{ name: "Home" }];
    if (requestedScene === "environments") {
      routes.push({
        name: "SettingsSheet",
        state: {
          index: 0,
          routes: [
            {
              name: "SettingsContent",
              state: {
                index: 1,
                routes: [{ name: "Settings" }, { name: "SettingsEnvironments" }],
              },
            },
          ],
        },
      });
    } else {
      routes.push({ name: "Thread", params });
      if (requestedScene === "terminal") {
        routes.push({
          name: "ThreadTerminal",
          params: { ...params, terminalId: "term-1" },
        });
      } else if (requestedScene === "review") {
        routes.push({ name: "ThreadReview", params });
      }
    }
    navigation.dispatch(
      CommonActions.reset({
        index: routes.length - 1,
        routes,
      }),
    );
  }, [hasFixture, navigation, requestedScene, scene, showcaseThread]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Stage remote agent activity for the native screenshot harness with cancellable retry work.
  useEffect(() => {
    if (scene !== "agent-activity" || !hasFixture || agentActivityStaged) {
      return;
    }
    let cancelled = false;
    let lastOutcome: string | null = null;
    void retryShowcaseOperation(
      async () => {
        const now = Date.now();
        const { threads: latestThreads, projects: latestProjects } = entitiesRef.current;
        const activity = buildShowcaseAgentActivity(latestThreads, latestProjects, now);
        const outcome =
          activity === null
            ? "fixture threads not loaded"
            : await stageShowcaseAgentActivity(activity, now);
        if (outcome === true) return true;
        if (outcome !== lastOutcome)
          console.warn(`[showcase] agent activity not staged: ${outcome}`);
        lastOutcome = outcome;
        return false;
      },
      { isCancelled: () => cancelled, attemptTimeoutMs: 60_000 },
    ).then((staged) => {
      if (!cancelled && staged) setAgentActivityStaged(true);
    });
    return () => {
      cancelled = true;
    };
  }, [agentActivityStaged, hasFixture, scene]);

  const readyRequest = useMemo(() => {
    if (
      scene === null ||
      requestedScene === null ||
      scene !== requestedScene ||
      !hasFixture ||
      !orientationSettled ||
      !themeApplied ||
      (scene === "agent-activity" && !agentActivityStaged) ||
      !isShowcaseNativeContentReady({ scene, themeId, renderSignal })
    )
      return null;
    return { scene };
  }, [
    agentActivityStaged,
    hasFixture,
    orientationSettled,
    renderSignal,
    requestedScene,
    scene,
    themeApplied,
    themeId,
  ]);
  const [completedReadyRequest, setCompletedReadyRequest] = useState<typeof readyRequest>(null);
  const readyScene = completedReadyRequest === readyRequest ? (readyRequest?.scene ?? null) : null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Wait for native render frames before reporting this scene request as ready to the capture harness.
  useEffect(() => {
    if (readyRequest === null) return;
    if (readyRequest.scene === "terminal") Keyboard.dismiss();

    let renderFrame: number | null = null;
    let readyFrame: number | null = null;
    const settleTimer = setTimeout(() => {
      renderFrame = requestAnimationFrame(() => {
        readyFrame = requestAnimationFrame(() => {
          markNativeShowcaseReady(readyRequest.scene);
          setCompletedReadyRequest(readyRequest);
        });
      });
    }, 500);
    return () => {
      clearTimeout(settleTimer);
      if (renderFrame !== null) cancelAnimationFrame(renderFrame);
      if (readyFrame !== null) cancelAnimationFrame(readyFrame);
    };
  }, [readyRequest]);

  if (readyScene === null) return null;

  return (
    <View
      pointerEvents="none"
      testID={`showcase-ready-${readyScene}`}
      style={{ position: "absolute", width: 1, height: 1, opacity: 0.01 }}
    />
  );
}
