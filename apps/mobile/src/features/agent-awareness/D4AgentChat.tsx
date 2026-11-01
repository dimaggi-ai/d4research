import {
  agentDraftMovedNotice,
  agentDraftOrigin,
  agentMentionOptions,
  agentMentionQuery,
  insertAgentMention,
  niaSystemTextSegments,
  type AgentDraftOrigin,
} from "@d4research/client-runtime/d4-agent-references";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { isSessionNotice, postTime } from "./d4AgentPresentation";
import { useEnvironmentQuery } from "../../state/query";
import {
  D4AgentError,
  type D4AgentState,
  type EnvironmentId,
  type ModelSelection,
  type ThreadId,
} from "@d4research/contracts";
import { squashAtomCommandFailure } from "@d4research/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useLinkTo } from "@react-navigation/native";
import * as Schema from "effect/Schema";
import { useMemo, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { resolveNativeMarkdownTypography } from "../../lib/appearancePreferences";
import { flattenThemeColor } from "../../lib/mobileTheme";
import { useFontFamily } from "../../lib/useFontFamily";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { AppText as Text } from "../../components/ui/AppText";
import {
  useEnvironmentServerConfig,
  useProjects,
  useThreadShells,
  useThreadShell,
} from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { D4AgentPanel } from "./D4Agent";
import { useD4AgentState } from "./useD4AgentState";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { ModelRow } from "../threads/ThreadSettingsRows";
import { AppBar } from "../../components/ui/AppBar";
import { ComposerEditor } from "../../components/ComposerEditor";
import {
  ComposerActionButton,
  ComposerInlineControl,
  ComposerToolbarRow,
  ComposerToolbarScroller,
} from "../../components/ComposerToolbar";
import { ComposerSurface } from "../threads/ThreadComposer";

const isD4AgentError = Schema.is(D4AgentError);

function taskFailureMessage(
  failure: unknown,
  providers: NonNullable<ReturnType<typeof useEnvironmentServerConfig>>["providers"],
  selection: ModelSelection | null,
) {
  if (!isD4AgentError(failure)) return "Could not send this message. Your draft is preserved.";
  if (failure.reason === "provider-unavailable") {
    const provider = providers.find((entry) => entry.instanceId === selection?.instanceId);
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
  if (failure.detail) return `${failure.detail} Your draft is preserved.`;
  if (failure.reason === "model-unavailable")
    return "The selected task model is unavailable. Choose another task model. Your draft is preserved.";
  if (failure.reason === "option-unavailable")
    return "The selected task model options are unavailable. Choose valid options or another task model. Your draft is preserved.";
  return "Could not send this message. Your draft is preserved.";
}

function useNiaMarkdownStyles() {
  const { appearance } = useAppearancePreferences();
  const theme = useUniwindTheme();
  const fontFamily = useFontFamily("regular");
  const boldFontFamily = useFontFamily("bold");
  return useMemo(() => {
    const typography = resolveNativeMarkdownTypography(appearance.baseFontSize);
    const common = {
      ...typography,
      fontFamily,
      headingFontFamily: boldFontFamily,
      boldFontFamily,
      contextChipBorderColor: flattenThemeColor(
        theme["--color-border"],
        theme["--color-user-bubble"],
      ),
    };
    const userColor = theme["--color-user-bubble-foreground"];
    return {
      user: {
        ...common,
        color: userColor,
        strongColor: userColor,
        mutedColor: userColor,
        linkColor: userColor,
        inlineCodeColor: theme["--color-user-bubble-foreground-muted"],
        codeColor: theme["--color-md-user-code-text"],
        codeBackgroundColor: theme["--color-md-user-code-bg"],
        codeBlockBackgroundColor: theme["--color-md-user-fence-bg"],
        fileTextColor: userColor,
        skillTextColor: theme["--color-user-bubble-skill-foreground"],
        quoteMarkerColor: userColor,
        dividerColor: userColor,
      },
      assistant: {
        ...common,
        color: theme["--color-md-body"],
        strongColor: theme["--color-md-strong"],
        mutedColor: theme["--color-md-body"],
        linkColor: theme["--color-md-link"],
        inlineCodeColor: theme["--color-foreground-secondary"],
        codeColor: theme["--color-md-code-text"],
        codeBackgroundColor: theme["--color-md-code-bg"],
        codeBlockBackgroundColor: theme["--color-md-code-bg"],
        fileTextColor: theme["--color-md-code-text"],
        skillTextColor: theme["--color-inline-skill-foreground"],
        quoteMarkerColor: theme["--color-md-blockquote-border"],
        dividerColor: theme["--color-md-hr"],
      },
    };
  }, [appearance.baseFontSize, theme, fontFamily, boldFontFamily]);
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
    <D4AgentChat environmentId={environmentId} state={state} refresh={query.refresh} />
  ) : (
    children
  );
}

export function D4AgentChat({
  environmentId,
  state,
  refresh,
}: {
  environmentId: EnvironmentId;
  state: D4AgentState;
  refresh: () => void;
}) {
  const markdownStyles = useNiaMarkdownStyles();
  const transcript = (state.transcript ?? []).filter((entry) => !isSessionNotice(entry));
  const config = useEnvironmentServerConfig(environmentId);
  const projects = useProjects();
  const threads = useThreadShells();
  const enabled = config?.settings.d4Agent.enabled === true;
  const send = useAtomCommand(serverEnvironment.sendD4AgentMessage);
  const allowed = useAtomValue(serverEnvironment.sendD4AgentMessage.permissionAtom(environmentId));
  const linkTo = useLinkTo();
  const [text, setText] = useState("");
  // undefined follows the saved default; null explicitly means manager-only conversation.
  const [taskSelectionOverride, setTaskSelectionOverride] = useState<
    ModelSelection | null | undefined
  >(undefined);
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
    taskSelectionOverride === undefined
      ? (config?.settings.d4Agent.taskModelSelection ?? null)
      : taskSelectionOverride;
  const taskGroups = groupByProvider(buildModelOptions(config, taskSelection, undefined, null));
  const conversation = useRef<ComponentRef<typeof ScrollView>>(null);
  const followConversation = useRef(true);
  const submit = async () => {
    if (sending || !enabled || !allowed || !text.trim() || moved) return;
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
      {state.threadId ? (
        <D4AgentPanel environmentId={environmentId} threadId={state.threadId} />
      ) : null}
      <ScrollView
        ref={conversation}
        className="flex-1"
        contentContainerClassName="gap-4 px-4 py-6"
        scrollEventThrottle={16}
        onScroll={(event) => {
          const { contentSize, contentOffset, layoutMeasurement } = event.nativeEvent;
          followConversation.current =
            contentSize.height - contentOffset.y - layoutMeasurement.height < 64;
        }}
        onContentSizeChange={() => {
          if (followConversation.current) conversation.current?.scrollToEnd({ animated: false });
        }}
      >
        {transcript.map((entry) => {
          const segments =
            entry.role === "system" ? niaSystemTextSegments(entry.text, entry.links) : null;
          // System text already shows every label; only links it could not place are repeated below.
          const inline = new Set(
            segments?.flatMap((segment) => (segment.kind === "thread" ? [segment.threadId] : [])),
          );
          const openThread = (threadId: ThreadId) =>
            linkTo(`/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`);
          return (
            <View
              key={entry.id}
              // Same row shapes as the thread feed: user bubble on the right, assistant text
              // unboxed, server posts as a quiet card.
              accessibilityLabel={
                entry.role === "user" ? "You" : entry.role === "assistant" ? "Nia" : entry.context
              }
              className={
                entry.role === "user"
                  ? "max-w-[85%] gap-2 self-end rounded-[20px] bg-user-bubble px-3.5 py-2.5"
                  : entry.role === "assistant"
                    ? "gap-2"
                    : "gap-2 rounded-xl border border-border px-3 py-2"
              }
            >
              {entry.role === "system" ? (
                <Text selectable className="text-sm text-foreground">
                  {segments?.map((segment, index) =>
                    segment.kind === "text" ? (
                      segment.text
                    ) : (
                      <Text
                        // oxlint-disable-next-line react/no-array-index-key -- segments of one immutable message
                        key={index}
                        accessibilityRole="link"
                        className="text-accent"
                        onPress={() =>
                          segment.kind === "url"
                            ? void tryOpenExternalUrl(segment.href, "markdown-link")
                            : openThread(segment.threadId)
                        }
                      >
                        {segment.text}
                      </Text>
                    ),
                  )}
                </Text>
              ) : (
                <SelectableMarkdownText
                  markdown={entry.text}
                  textStyle={markdownStyles[entry.role]}
                  preserveSoftBreaks={entry.role === "user"}
                  onLinkPress={(href) => {
                    if (/^https?:\/\//i.test(href)) void tryOpenExternalUrl(href, "markdown-link");
                  }}
                />
              )}
              {entry.links
                .filter(
                  (link) =>
                    segments === null || (link.threadId !== null && !inline.has(link.threadId)),
                )
                .map((link) =>
                  link.threadId ? (
                    <Pressable
                      key={`${link.label}:${link.threadId ?? link.projectId ?? "label"}`}
                      accessibilityRole="link"
                      onPress={() => openThread(link.threadId!)}
                      className="py-2"
                    >
                      <Text className="text-accent">{link.label}</Text>
                    </Pressable>
                  ) : (
                    <Text
                      key={`${link.label}:${link.threadId ?? link.projectId ?? "label"}`}
                      className="text-sm text-foreground-muted"
                    >
                      {link.label}
                    </Text>
                  ),
                )}
              {entry.role === "user" ? null : (
                <Text className="text-xs text-foreground-muted">{postTime(entry.createdAt)}</Text>
              )}
            </View>
          );
        })}
        {transcript.length === 0 ? (
          <Text className="text-sm text-foreground-muted">
            Ask what needs attention, send a message to a thread, or start research.
          </Text>
        ) : null}
      </ScrollView>
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
              value={text}
              editable={enabled && allowed && !sending}
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
                label={
                  taskSelection
                    ? `${taskSelection.instanceId} · ${taskSelection.model}`
                    : "No task model"
                }
                onPress={() => setTaskPickerOpen(true)}
              />
              <ComposerInlineControl
                disabled={sending || taskSelection === null}
                label="No task model"
                onPress={() => {
                  setTaskSelectionOverride(null);
                  bindDraft();
                }}
                showChevron={false}
              />
            </ComposerToolbarScroller>
            <ComposerActionButton
              accessibilityLabel={sending ? "Sending" : "Send"}
              disabled={!enabled || !allowed || sending || !text.trim() || moved !== null}
              icon="arrow.up"
              onPress={() => void submit()}
              variant="primary"
            />
          </ComposerToolbarRow>
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
      <Modal
        visible={taskPickerOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setTaskPickerOpen(false)}
      >
        <View className="flex-1 bg-background pt-6">
          <View className="flex-row items-center justify-between px-5 pb-4">
            <Text className="text-lg font-t3-semibold text-foreground">Task model</Text>
            <Pressable
              accessibilityRole="button"
              className="p-2"
              onPress={() => setTaskPickerOpen(false)}
            >
              <Text className="text-base text-accent">Done</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerClassName="gap-4 pb-10">
            <Pressable
              accessibilityRole="button"
              className="px-5 py-3"
              onPress={() => {
                setTaskSelectionOverride(null);
                setTaskPickerOpen(false);
                bindDraft();
              }}
            >
              <Text className="text-foreground">No task model</Text>
            </Pressable>
            {taskGroups.map((group) => (
              <View key={group.providerKey} className="gap-2">
                <Text className="px-5 text-sm text-foreground-muted">{group.providerLabel}</Text>
                {group.models.map((option, index) => (
                  <ModelRow
                    key={option.key}
                    option={option}
                    selected={
                      option.selection.instanceId === taskSelection?.instanceId &&
                      option.selection.model === taskSelection.model
                    }
                    onPress={() => {
                      setTaskSelectionOverride(option.selection);
                      setTaskPickerOpen(false);
                      bindDraft();
                    }}
                    isFavorite={false}
                    favoritesLoaded={false}
                    onToggleFavorite={() => {}}
                    isFirst={index === 0}
                    isLast={index === group.models.length - 1}
                  />
                ))}
              </View>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}
