import { appendNiaSystemNotices } from "@d4research/client-runtime/d4-agent-timeline";
import { AuthOrchestrationOperateScope } from "@d4research/contracts";
import { useEnvironmentScope } from "../../state/session";
import { useThreadRequests } from "../../state/use-selected-thread-requests";
import { PendingApprovalCard } from "../threads/PendingApprovalCard";
import { PendingUserInputCard } from "../threads/PendingUserInputCard";
import type { LegendListRef } from "@legendapp/list/react-native";
import { useSharedValue, useDerivedValue } from "react-native-reanimated";
import * as Option from "effect/Option";
import { deriveThreadCheckpointSummaries } from "@d4research/client-runtime/state/thread-checkpoints";
import {
  deriveThreadActivityRun,
  deriveThreadRuntime,
  deriveRunlessWorkStartedAt,
} from "@d4research/client-runtime/state/thread-execution";
import { resolveThreadWorkingStartedAt } from "@d4research/client-runtime/state/models";
import { buildThreadFeed, createThreadFeedCache } from "../../lib/threadActivity";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import { AsyncResult } from "effect/reactivity";
import { useEnvironmentThread, threadEnvironment } from "../../state/threads";
import { ThreadFeed } from "../threads/ThreadFeed";
import { WorkspaceMutationIdProvider } from "../threads/WorkspaceMutationIdProvider";
import { projectThreadContentPresentation } from "../threads/threadContentPresentation";
import {
  agentDraftMovedNotice,
  agentDraftOrigin,
  agentMentionOptions,
  agentMentionQuery,
  insertAgentMention,
  type AgentDraftOrigin,
} from "@d4research/client-runtime/d4-agent-references";
import { useEnvironmentQuery } from "../../state/query";
import {
  D4AgentError,
  resolveD4AgentTaskModelSelection,
  type D4AgentState,
  type EnvironmentId,
  type ModelSelection,
  type ThreadId,
} from "@d4research/contracts";
import { squashAtomCommandFailure } from "@d4research/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { useRef, useState, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { AppText as Text } from "../../components/ui/AppText";
import {
  useEnvironmentServerConfig,
  useProjects,
  useThreadShells,
  useThreadShell,
} from "../../state/entities";
import { scopeThreadRef } from "@d4research/client-runtime/environment";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { D4AgentPanel } from "./D4Agent";
import { useD4AgentState } from "./useD4AgentState";
import { formatModelSelectionLabel } from "@d4research/client-runtime/state/provider-instance-display";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { ModelPickerSheet } from "../settings/PickerSheet";
import { AppBar } from "../../components/ui/AppBar";
import { ComposerEditor, type ComposerEditorSelection } from "../../components/ComposerEditor";
import {
  ComposerActionButton,
  ComposerInlineControl,
  ComposerToolbarRow,
  ComposerToolbarScroller,
} from "../../components/ComposerToolbar";
import { ComposerSurface } from "../threads/ThreadComposer";
import {
  ComposerDictationCancelAction,
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";

const isD4AgentError = Schema.is(D4AgentError);

function taskFailureMessage(
  failure: unknown,
  providers: NonNullable<ReturnType<typeof useEnvironmentServerConfig>>["providers"],
  selection: ModelSelection,
) {
  if (!isD4AgentError(failure)) return "Could not send this message. Your draft is preserved.";
  if (failure.reason === "provider-unavailable") {
    const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
    const quotaExhausted =
      provider?.usageLimits?.windows.some(
        (window) =>
          window.usedPercent >= 100 &&
          (window.resetsAt === undefined || Date.parse(window.resetsAt) > Date.now()),
      ) === true;
    return quotaExhausted
      ? "The selected task provider is out of quota. Choose another task model or try again after the quota resets. Your draft is preserved."
      : "The selected task provider is unavailable or not authenticated. Check the provider connection or choose another task model. Your draft is preserved.";
  }
  if (failure.reason === "model-mismatch") return `${failure.message} Your draft is preserved.`;
  if (failure.detail) return `${failure.detail} Your draft is preserved.`;
  if (failure.reason === "model-unavailable")
    return "The selected task model is unavailable. Choose another task model. Your draft is preserved.";
  if (failure.reason === "option-unavailable")
    return "The selected task model options are unavailable. Choose valid options or another task model. Your draft is preserved.";
  return "Could not send this message. Your draft is preserved.";
}

export function D4AgentRoute({
  environmentId,
  threadId,
  children,
}: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  children: ReactNode;
}) {
  const identity = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.d4AgentIdentity({ environmentId, input: {} }),
  );
  const shell = useThreadShell(
    environmentId !== null && threadId !== null ? { environmentId, threadId } : null,
  );
  const isAgentProject =
    environmentId !== null &&
    threadId !== null &&
    identity.data !== null &&
    (identity.data.threadId === threadId || shell?.projectId === identity.data.projectId);
  const resolveArchivedRoute = environmentId !== null && threadId !== null && shell === null;
  const query = useD4AgentState(environmentId, isAgentProject || resolveArchivedRoute);
  const state = query.data;
  const [viewed, setViewed] = useState({
    environmentId,
    routeThreadId: threadId,
    activeThreadId: state?.threadId ?? null,
    context: state?.brainContext ?? null,
    threadId,
  });
  if (viewed.environmentId !== environmentId || viewed.routeThreadId !== threadId) {
    setViewed({
      environmentId,
      routeThreadId: threadId,
      activeThreadId: state?.threadId ?? null,
      context: state?.brainContext ?? null,
      threadId,
    });
  } else if (
    state &&
    (viewed.activeThreadId !== state.threadId || viewed.context !== state.brainContext)
  ) {
    const followActive =
      viewed.activeThreadId === viewed.threadId ||
      (viewed.context !== null && viewed.context !== state.brainContext);
    setViewed({
      ...viewed,
      activeThreadId: state.threadId,
      context: state.brainContext,
      threadId: followActive && state.threadId !== null ? state.threadId : viewed.threadId,
    });
  }
  const isAgentRoute =
    isAgentProject || (threadId !== null && state?.chatThreadIds?.includes(threadId) === true);
  if (
    (environmentId !== null && identity.isPending && identity.data === null) ||
    (isAgentProject && !state) ||
    (resolveArchivedRoute && !state && query.error === null)
  )
    return (
      <View className="flex-1 justify-center bg-background p-4">
        <Text className="text-sm text-foreground-muted">Loading Nia…</Text>
      </View>
    );
  return isAgentRoute && state && environmentId !== null ? (
    <D4AgentChat
      environmentId={environmentId}
      state={state}
      refresh={query.refresh}
      threadId={viewed.threadId}
      onSent={(threadId) => setViewed((current) => ({ ...current, threadId }))}
    />
  ) : (
    children
  );
}

export function D4AgentChat({
  environmentId,
  state,
  refresh,
  threadId: requestedThreadId,
  onSent,
}: {
  environmentId: EnvironmentId;
  state: D4AgentState;
  refresh: () => void;
  threadId?: ThreadId | null;
  onSent?: (threadId: ThreadId) => void;
}) {
  const threadId = requestedThreadId === undefined ? state.threadId : requestedThreadId;
  const insets = useSafeAreaInsets();
  const config = useEnvironmentServerConfig(environmentId);
  const projects = useProjects();
  const threads = useThreadShells();
  const enabled = config?.settings.d4Agent.enabled === true;
  const send = useAtomCommand(serverEnvironment.sendD4AgentMessage);
  const allowed = useAtomValue(serverEnvironment.sendD4AgentMessage.permissionAtom(environmentId));
  const [text, setTextState] = useState("");
  // Dictation reads and watches the draft outside render, so it mirrors the text in a ref.
  const textRef = useRef("");
  const textListeners = useRef(new Set<() => void>());
  const setText = (next: string | ((current: string) => string)) => {
    const value = typeof next === "function" ? next(textRef.current) : next;
    textRef.current = value;
    setTextState(value);
    for (const listener of textListeners.current) listener();
  };
  const [selection, setSelection] = useState<ComposerEditorSelection>({ start: 0, end: 0 });
  // undefined follows the saved default task model; there is always a concrete task model.
  const [taskSelectionOverride, setTaskSelectionOverride] = useState<ModelSelection | undefined>(
    undefined,
  );
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const [origin, setOrigin] = useState<AgentDraftOrigin | null>(null);
  if (!text.trim() && origin !== null) setOrigin(null);
  const bindDraft = () => setOrigin((current) => current ?? agentDraftOrigin(state));
  const moved = agentDraftMovedNotice(origin, state);
  const mentions = agentMentionOptions({
    environmentId,
    context: state.brainContext,
    agentProjectId: state.projectId,
    settings: config?.settings,
    projects,
    threads,
    query: agentMentionQuery(text),
  });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taskSelection =
    taskSelectionOverride ??
    resolveD4AgentTaskModelSelection(config?.settings.d4Agent ?? { taskModelSelection: null });
  const voiceInput = useVoiceInputController({
    ownerKey: state.threadId === null ? "nia" : `nia:${state.threadId}`,
    label: "Nia",
    readDraftMessage: () => textRef.current,
    subscribeToDraftChanges: (onChange) => {
      textListeners.current.add(onChange);
      return () => textListeners.current.delete(onChange);
    },
    selection,
    disabled: !enabled || !allowed || sending,
    onChangeDraftMessage: (value) => {
      setText(value.slice(0, 16000));
      if (value.trim()) bindDraft();
    },
    onChangeSelection: setSelection,
  });
  const voicePresentation = resolveVoiceComposerPresentation(
    voiceInput.state,
    voiceInput.elapsedSeconds,
  );
  const showsDictation = voicePresentation.statusLabel !== null;
  const taskGroups = groupByProvider(buildModelOptions(config, taskSelection, undefined, null));
  const submit = async () => {
    if (sending || !enabled || !allowed || !text.trim() || moved || voiceInput.blocksSubmission)
      return;
    const submitted = text;
    const target = origin ?? agentDraftOrigin(state);
    setSending(true);
    setError(null);
    // A rejected command reads as null; the React Compiler cannot compile a conditional in try.
    const result = await send({
      environmentId,
      input: {
        text: submitted.trim(),
        taskModelSelection: taskSelection,
        expectedContext: target.context,
        expectedThreadId: target.threadId,
      },
    }).catch(() => null);
    if (result === null) {
      setError("Could not send this message. Your draft is preserved.");
    } else if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      const stale = isD4AgentError(failure) && failure.reason === "stale";
      setError(
        stale
          ? "Not sent: Nia's context or session changed after you wrote this. Your draft is preserved. Check it, then send again."
          : taskFailureMessage(failure, config?.providers ?? [], taskSelection),
      );
      // The resend must carry the current context and session, not the ones that went stale.
      if (stale) refresh();
    } else {
      setText((current) => (current === submitted ? "" : current));
      setTaskSelectionOverride(undefined);
      onSent?.(result.value.threadId);
      refresh();
    }
    setSending(false);
  };
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      className="flex-1 bg-background"
    >
      <AppBar title="Nia" />
      <View style={{ paddingTop: NATIVE_LIQUID_GLASS_SUPPORTED ? insets.top : 0 }}>
        {state.threadId ? (
          <D4AgentPanel environmentId={environmentId} threadId={state.threadId} />
        ) : null}
      </View>
      {threadId ? (
        <NiaThreadFeed
          key={`${environmentId}:${threadId}`}
          environmentId={environmentId}
          threadId={threadId}
          state={state}
        />
      ) : (
        <View className="flex-1 px-4 py-6">
          <Text className="text-sm text-foreground-muted">
            Ask what needs attention, send a message to a thread, or start research.
          </Text>
        </View>
      )}
      {threadId ? (
        <NiaThreadRequests
          key={`${environmentId}:${threadId}`}
          environmentId={environmentId}
          threadId={threadId}
        />
      ) : null}
      <View className="gap-2 px-4 pb-4 pt-2">
        {agentMentionQuery(text) !== null && enabled && allowed ? (
          <ScrollView
            accessibilityLabel="Mention a thread, project, or pipeline"
            className="max-h-48"
          >
            {mentions.map((mention) => (
              <Pressable
                key={`${mention.kind}:${mention.id}`}
                accessibilityRole="button"
                className="px-3 py-3"
                onPress={() => {
                  setText((current) => insertAgentMention(current, mention));
                  bindDraft();
                }}
              >
                <Text className="text-accent">
                  {mention.kind} · {mention.title}
                </Text>
              </Pressable>
            ))}
            {mentions.length === 0 ? (
              <Text className="text-sm text-foreground-muted">No matching references.</Text>
            ) : null}
          </ScrollView>
        ) : null}
        <ComposerSurface
          animateLayout={false}
          style={{ borderRadius: 26, minHeight: 112, overflow: "hidden", paddingTop: 10 }}
        >
          <View className="min-h-16 px-3">
            <ComposerEditor
              placeholder="Message Nia"
              multiline
              // The native iOS editor has no intrinsic height; unsized it collapses to zero and cannot be tapped.
              style={{ minHeight: 64 }}
              value={text}
              selection={selection}
              onSelectionChange={setSelection}
              editable={enabled && allowed && !sending}
              readOnly={voiceInput.freezesEditor}
              onChangeText={(value) => {
                const bounded = value.slice(0, 16000);
                setText(bounded);
                if (bounded.trim()) bindDraft();
              }}
              onSubmit={() => void submit()}
            />
          </View>
          <ComposerToolbarRow paddingBottom={4} paddingTop={2}>
            <ComposerToolbarScroller>
              <ComposerInlineControl
                accessibilityLabel="Nia task model"
                disabled={sending}
                emphasized
                icon="brain"
                label={`Tasks · ${formatModelSelectionLabel(config?.providers, taskSelection)}`}
                maxWidth="100%"
                onPress={() => setTaskPickerOpen(true)}
              />
            </ComposerToolbarScroller>
            {showsDictation ? null : (
              <ComposerDictationStartAction
                state={voiceInput.state}
                isAvailable={voiceInput.isAvailable}
                disabled={!enabled || !allowed || sending}
                onStart={voiceInput.start}
                onCancel={voiceInput.cancel}
              />
            )}
            <ComposerActionButton
              accessibilityLabel={sending ? "Sending" : "Send"}
              disabled={
                !enabled ||
                !allowed ||
                sending ||
                !text.trim() ||
                moved !== null ||
                voiceInput.blocksSubmission
              }
              icon="arrow.up"
              onPress={() => void submit()}
              variant="primary"
            />
          </ComposerToolbarRow>
          {showsDictation ? (
            <ComposerDictationToolbar showsDictation>
              <View className="h-11 flex-row items-center px-2">
                <ComposerDictationCancelAction
                  presentation={voicePresentation}
                  onCancel={voiceInput.cancel}
                />
                <ComposerDictationStatus
                  audioLevels={voiceInput.audioLevels}
                  elapsedSeconds={voiceInput.elapsedSeconds}
                  phase={voiceInput.state.phase}
                  presentation={voicePresentation}
                />
                <ComposerDictationPrimaryAction
                  state={voiceInput.state}
                  presentation={voicePresentation}
                  isAvailable={voiceInput.isAvailable}
                  disabled={!enabled || !allowed || sending}
                  onStart={voiceInput.start}
                  onConfirm={voiceInput.stop}
                  onCancel={voiceInput.cancel}
                />
              </View>
            </ComposerDictationToolbar>
          ) : null}
        </ComposerSurface>
        {moved ? (
          <View className="gap-2">
            <Text accessibilityRole="alert" className="text-sm text-foreground">
              {moved.message}
            </Text>
            <Pressable
              accessibilityRole="button"
              className="self-start px-4 py-3"
              onPress={() => {
                setOrigin(agentDraftOrigin(state));
                setError(null);
              }}
            >
              <Text className="text-accent">{moved.reassignLabel}</Text>
            </Pressable>
          </View>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
            {error}
          </Text>
        ) : null}
      </View>
      <ModelPickerSheet
        title="Task model"
        visible={taskPickerOpen}
        groups={taskGroups}
        selected={taskSelection}
        onSelect={(option) => {
          setTaskSelectionOverride(option.selection);
          setTaskPickerOpen(false);
          bindDraft();
        }}
        onClose={() => setTaskPickerOpen(false)}
      />
    </KeyboardAvoidingView>
  );
}

function NiaThreadFeed({
  environmentId,
  threadId,
  state,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  state: D4AgentState;
}) {
  const detail = useEnvironmentThread(environmentId, threadId);
  const projection = Option.getOrNull(detail.data);
  const thread = projection?.thread;
  const connection = useRemoteEnvironmentRuntime(environmentId);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const projects = useProjects();
  const [cache] = useState(createThreadFeedCache);
  const listRef = useRef<LegendListRef | null>(null);
  const freeze = useSharedValue(false);
  const contentInsetEndAdjustment = useSharedValue(0);
  const loadEarlierHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  const context =
    threadId === state.threadId
      ? state.brainContext
      : state.openSessions?.find((session) => session.threadId === threadId)?.context;
  const items = projection?.visibleTurnItems ?? [];
  const feed = buildThreadFeed(
    context === undefined
      ? items
      : appendNiaSystemNotices(items, state.transcript ?? [], environmentId, threadId, context),
    {
      attempts: projection?.attempts,
      nodes: projection?.nodes,
      checkpointSummaries: projection ? deriveThreadCheckpointSummaries(projection) : [],
      cache,
    },
  );
  const latestRun = projection ? deriveThreadActivityRun(projection) : null;
  const runtime = projection ? deriveThreadRuntime(projection) : null;
  const runlessWorkStartedAt = projection ? deriveRunlessWorkStartedAt(projection) : null;
  const detailRef = scopeThreadRef(environmentId, threadId);
  return (
    <WorkspaceMutationIdProvider threadRef={detailRef}>
      <ThreadFeed
        environmentId={environmentId}
        threadId={threadId}
        detailRef={detailRef}
        threadTitle={thread?.title ?? "Nia"}
        workspaceRoot={
          thread?.worktreePath ??
          projects.find(
            (project) =>
              project.environmentId === environmentId && project.id === thread?.projectId,
          )?.workspaceRoot
        }
        feed={feed}
        toolCallVisibility={
          AsyncResult.isSuccess(preferences)
            ? (preferences.value.toolCallVisibility ?? "showAll")
            : "showAll"
        }
        queuedMessages={[]}
        dispatchingMessageId={null}
        onEditPendingMessage={null}
        contentPresentation={projectThreadContentPresentation({
          hasDetail: projection !== null,
          detailError: Option.getOrNull(detail.error),
          detailDeleted: detail.status === "deleted",
          connectionState: connection?.connectionState ?? "available",
        })}
        latestRun={latestRun}
        activeWorkStartedAt={
          resolveThreadWorkingStartedAt({ latestRun, runtime }) ?? runlessWorkStartedAt
        }
        runlessWorkActive={runlessWorkStartedAt !== null}
        listRef={listRef}
        freeze={freeze}
        anchorMessageId={null}
        contentInsetEndAdjustment={contentInsetEndAdjustment}
        keyboardOffset={0}
        contentTopInset={24}
        historyControls={
          detail.history.hasMoreHistory || detail.history.error !== null
            ? {
                hasMoreHistory: detail.history.hasMoreHistory,
                loading: detail.history.loading,
                error: detail.history.error,
                onLoadEarlier: () => {
                  void loadEarlierHistory({ environmentId, input: { threadId } });
                },
                onLoadThrough: (throughEntryId) => {
                  void loadEarlierHistory({ environmentId, input: { threadId, throughEntryId } });
                },
              }
            : undefined
        }
      />
    </WorkspaceMutationIdProvider>
  );
}

function NiaThreadRequests({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const requests = useThreadRequests(scopeThreadRef(environmentId, threadId));
  const canOperateThread = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const { height } = useWindowDimensions();
  const maxHeight = useDerivedValue(() => height * 0.5);
  const [collapsed, setCollapsed] = useState(false);
  const cardProgress = useDerivedValue<number>(() => (collapsed ? 0 : 1));
  const cardCoverage = useSharedValue(0);
  return (
    <View className="gap-3 px-4">
      {requests.activePendingApproval ? (
        <PendingApprovalCard
          canOperateThread={canOperateThread}
          approval={requests.activePendingApproval}
          respondingApprovalId={requests.respondingApprovalId}
          onRespond={requests.onRespondToApproval}
        />
      ) : null}
      {requests.activePendingUserInput ? (
        <PendingUserInputCard
          key={requests.activePendingUserInput.requestId}
          environmentId={environmentId}
          canOperateThread={canOperateThread}
          pendingUserInput={requests.activePendingUserInput}
          maxHeight={maxHeight}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed(!collapsed)}
          cardProgress={cardProgress}
          cardCoverage={cardCoverage}
          drafts={requests.activePendingUserInputDrafts}
          answers={requests.activePendingUserInputAnswers}
          respondingUserInputId={requests.respondingUserInputId}
          onSelectOption={requests.onSelectUserInputOption}
          onChangeCustomAnswer={requests.onChangeUserInputCustomAnswer}
          onSubmit={requests.onSubmitUserInput}
          onDismiss={requests.onDismissUserInput}
        />
      ) : null}
    </View>
  );
}
