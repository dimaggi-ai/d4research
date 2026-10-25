import {
  agentMentionOptions,
  agentMentionQuery,
  insertAgentMention,
} from "@d4research/client-runtime/d4-agent-references";
import { useEnvironmentQuery } from "../../state/query";
import type { D4AgentState, EnvironmentId, ThreadId } from "@d4research/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useLinkTo } from "@react-navigation/native";
import { useRef, useState, type ComponentRef, type ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from "react-native";
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
        <Text className="text-sm text-foreground-muted">Loading d4 Agent…</Text>
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
  const config = useEnvironmentServerConfig(environmentId);
  const projects = useProjects();
  const threads = useThreadShells();
  const enabled = config?.settings.d4Agent.enabled === true;
  const send = useAtomCommand(serverEnvironment.sendD4AgentMessage);
  const allowed = useAtomValue(serverEnvironment.sendD4AgentMessage.permissionAtom(environmentId));
  const linkTo = useLinkTo();
  const [text, setText] = useState("");
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
  const [error, setError] = useState(false);
  const conversation = useRef<ComponentRef<typeof ScrollView>>(null);
  const followConversation = useRef(true);
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      className="flex-1 bg-background"
    >
      <View className="flex-row items-center justify-between border-b border-border px-4 py-3">
        <Text className="text-lg font-t3-semibold text-foreground">d4 Agent</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => linkTo("/settings/thread-preferences")}
        >
          <Text className="text-accent">Settings</Text>
        </Pressable>
      </View>
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
        {(state.transcript ?? []).map((entry) => (
          <View
            key={entry.id}
            className={entry.role === "system" ? "gap-2 border-y border-border py-2" : "gap-2"}
          >
            <Text className="text-xs text-foreground-muted">
              {entry.role === "user"
                ? "You"
                : entry.role === "assistant"
                  ? "d4 Agent"
                  : entry.context}
            </Text>
            <Text
              selectable
              className={
                entry.role === "system"
                  ? "text-xs text-foreground-muted"
                  : "text-base text-foreground"
              }
            >
              {entry.text}
            </Text>
            {entry.links.map((link) =>
              link.threadId ? (
                <Pressable
                  key={`${link.label}:${link.threadId ?? link.projectId ?? "label"}`}
                  accessibilityRole="link"
                  onPress={() =>
                    linkTo(
                      `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(link.threadId!)}`,
                    )
                  }
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
          </View>
        ))}
        {(state.transcript ?? []).length === 0 ? (
          <Text className="text-sm text-foreground-muted">
            Ask what needs attention, send a message to a thread, or start research.
          </Text>
        ) : null}
      </ScrollView>
      <View className="gap-2 border-t border-border p-4">
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
                onPress={() => setText((current) => insertAgentMention(current, mention))}
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
        <TextInput
          accessibilityLabel="Message d4 Agent"
          multiline
          value={text}
          maxLength={16000}
          editable={enabled && allowed && !sending}
          onChangeText={setText}
          className="min-h-20 rounded-xl border border-border p-3 text-foreground"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !enabled || !allowed || sending || !text.trim() }}
          disabled={!enabled || !allowed || sending || !text.trim()}
          className="self-end px-4 py-3"
          onPress={async () => {
            if (sending || !enabled || !allowed || !text.trim()) return;
            const submitted = text;
            setSending(true);
            setError(false);
            try {
              const result = await send({ environmentId, input: { text: submitted.trim() } });
              if (result._tag === "Failure") setError(true);
              else {
                setText((current) => (current === submitted ? "" : current));
                refresh();
              }
            } catch {
              setError(true);
            }
            setSending(false);
          }}
        >
          <Text className="text-accent">{sending ? "Sending…" : "Send"}</Text>
        </Pressable>
        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
            Could not send this message. Your draft is preserved.
          </Text>
        ) : null}
      </View>
    </KeyboardAvoidingView>
  );
}
