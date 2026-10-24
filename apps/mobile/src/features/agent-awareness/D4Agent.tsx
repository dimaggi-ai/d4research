import * as Arr from "effect/Array";
import {
  systemCheckLabel,
  systemCheckStatus,
  agentUnavailableMessage,
} from "./d4AgentPresentation";
import { useAtomValue } from "@effect/atom-react";
import { useLinkTo } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@d4research/contracts";
import { useState } from "react";
import { Pressable, View, ScrollView } from "react-native";
import {
  agentMonitorLabel,
  monitorAttentionThreads,
  AGENT_MONITOR_LIST_LIMIT,
} from "@d4research/client-runtime/state/agent-monitor";
import { AppText as Text } from "../../components/ui/AppText";
import { useThreadShells, useEnvironmentServerConfig } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";

export function D4AgentEntry({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label?: string;
}) {
  const config = useEnvironmentServerConfig(environmentId);
  const state = useEnvironmentQuery(
    config?.settings.d4Agent.enabled
      ? serverEnvironment.d4AgentState({ environmentId, input: {} })
      : null,
  );
  const ensure = useAtomCommand(serverEnvironment.ensureD4AgentThread);
  const allowed = useAtomValue(serverEnvironment.ensureD4AgentThread.permissionAtom(environmentId));
  const linkTo = useLinkTo();
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(false);
  return (
    <View className="px-4 py-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`d4 Agent${label ? ` · ${label}` : ""}`}
        disabled={
          !config ||
          opening ||
          (config.settings.d4Agent.enabled === true && !state.data?.threadId && !allowed)
        }
        className="rounded-xl bg-surface px-4 py-3"
        onPress={async () => {
          if (!config) return;
          if (!config.settings.d4Agent.enabled) {
            linkTo("/settings/thread-preferences");
            return;
          }
          if (state.data?.threadId) {
            linkTo(
              `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(state.data.threadId)}`,
            );
            return;
          }
          setOpening(true);
          setError(false);
          await ensure({ environmentId, input: {} })
            .then((result) => {
              if (result._tag === "Success")
                linkTo(
                  `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(result.value.threadId)}`,
                );
              else setError(true);
            })
            .catch(() => setError(true))
            .finally(() => setOpening(false));
        }}
      >
        <Text className="text-base font-t3-semibold text-foreground">
          {opening ? "Opening d4 Agent…" : `d4 Agent${label ? ` · ${label}` : ""}`}
        </Text>
      </Pressable>
      {error ? (
        <Text accessibilityRole="alert" className="py-2 text-sm text-foreground-muted">
          Could not open d4 Agent. Check that it is enabled with an available model in Settings.
        </Text>
      ) : null}
    </View>
  );
}
export function D4AgentPanel({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const config = useEnvironmentServerConfig(environmentId);
  return config?.settings.d4Agent.enabled ? (
    <D4AgentPanelContent environmentId={environmentId} threadId={threadId} />
  ) : null;
}
function D4AgentPanelContent({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const query = useEnvironmentQuery(serverEnvironment.d4AgentState({ environmentId, input: {} }));
  const threads = useThreadShells();
  const linkTo = useLinkTo();
  const resolve = useAtomCommand(serverEnvironment.resolveD4AgentAction);
  const allowed = useAtomValue(
    serverEnvironment.resolveD4AgentAction.permissionAtom(environmentId),
  );
  const monitorEnabled =
    useEnvironmentServerConfig(environmentId)?.settings.agentMonitor.enabled === true;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const state = query.data;
  if (!state || state.threadId !== threadId) return null;
  const attention = monitorEnabled
    ? monitorAttentionThreads(
        threads.filter(
          (thread) =>
            thread.environmentId === environmentId &&
            thread.archivedAt === null &&
            thread.deletedAt === null,
        ),
      )
    : [];
  return (
    <View className="max-h-64 border-b border-border bg-surface">
      <ScrollView contentContainerClassName="gap-2 px-4 py-3">
        <View className="flex-row items-center justify-between">
          <Text className="font-t3-semibold text-foreground">
            Needs attention · {attention.length}
          </Text>
          <Pressable accessibilityRole="button" onPress={query.refresh}>
            <Text className="text-accent">Refresh</Text>
          </Pressable>
        </View>
        {!state.modelAvailable ? (
          <Text className="text-sm text-foreground-muted">
            {agentUnavailableMessage(state.unavailableReason)}
          </Text>
        ) : null}
        {attention.length === 0 ? (
          <Text className="text-sm text-foreground-muted">No threads need attention.</Text>
        ) : (
          attention.slice(0, AGENT_MONITOR_LIST_LIMIT).map((thread) => (
            <Pressable
              key={thread.id}
              accessibilityRole="button"
              onPress={() =>
                linkTo(
                  `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(thread.id)}`,
                )
              }
            >
              <Text className="text-sm text-accent">
                {thread.title} · {agentMonitorLabel(thread.source.agentMonitor!)}
              </Text>
            </Pressable>
          ))
        )}
        {state.systemHealth.map((check) => (
          <Text key={check.id} className="text-sm text-foreground-muted">
            {systemCheckLabel(check)}: {systemCheckStatus(check)}
          </Text>
        ))}
        {state.pendingActions.slice(0, 20).map((record) => (
          <View key={record.id} className="gap-2">
            <Text className="text-sm text-foreground">
              Approve {record.action.type}
              {"threadId" in record.action
                ? ` · ${record.action.threadId}`
                : ` · ${record.action.projectId}`}
              ?
            </Text>
            {"text" in record.action ? (
              <Text className="text-sm text-foreground-muted">{record.action.text}</Text>
            ) : null}
            {record.action.type === "answer" ? (
              <Text className="text-sm text-foreground-muted">
                {JSON.stringify(record.action.answers)}
              </Text>
            ) : null}
            <View className="flex-row gap-4">
              {(["approve", "deny"] as const).map((decision) => (
                <Pressable
                  key={decision}
                  accessibilityRole="button"
                  disabled={!allowed || busy}
                  className="px-2 py-2"
                  onPress={async () => {
                    setBusy(true);
                    setActionError(null);
                    await resolve({ environmentId, input: { actionId: record.id, decision } })
                      .then((result) => {
                        if (result._tag === "Failure")
                          setActionError("Could not resolve this action.");
                        query.refresh();
                      })
                      .catch(() => setActionError("Could not resolve this action."))
                      .finally(() => setBusy(false));
                  }}
                >
                  <Text className="text-accent">{decision === "approve" ? "Approve" : "Deny"}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ))}
        {state.actionLog.length > 0 ? (
          <>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              onPress={() => setExpanded(!expanded)}
            >
              <Text className="text-sm text-accent">Action log · {state.actionLog.length}</Text>
            </Pressable>
            {expanded
              ? Arr.reverse(state.actionLog.slice(-20)).map((record) => (
                  <Text key={record.id} className="text-xs text-foreground-muted">
                    {record.createdAt} · {record.action.type} · {record.status}
                  </Text>
                ))
              : null}
          </>
        ) : null}
        {query.error ? <Text accessibilityRole="alert">{query.error}</Text> : null}
        {actionError ? <Text accessibilityRole="alert">{actionError}</Text> : null}
      </ScrollView>
    </View>
  );
}
