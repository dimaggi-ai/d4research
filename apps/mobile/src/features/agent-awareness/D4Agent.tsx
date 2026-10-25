import * as Effect from "effect/Effect";
import { waitForD4AgentThreadShell } from "@d4research/client-runtime/state/server";
import { environmentThreadShells } from "../../state/threads";
import { appAtomRegistry } from "../../state/atom-registry";
import { useD4AgentState } from "./useD4AgentState";
import {
  systemCheckLabel,
  systemCheckStatus,
  agentUnavailableMessage,
  projectBelongsToAgentContext,
} from "./d4AgentPresentation";
import { useAtomValue } from "@effect/atom-react";
import { useLinkTo } from "@react-navigation/native";
import {
  D4_BRAIN_CONTEXTS,
  type D4AgentActionSummary,
  type EnvironmentId,
  type ThreadId,
} from "@d4research/contracts";
import { useState } from "react";
import { Pressable, View, ScrollView, Modal } from "react-native";
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

function waitForAgentThread(environmentId: EnvironmentId, threadId: ThreadId) {
  return Effect.runPromise(
    waitForD4AgentThreadShell(
      appAtomRegistry,
      environmentThreadShells.threadShellAtom({ environmentId, threadId }),
    ),
  );
}

export function D4AgentEntry({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label?: string;
}) {
  const config = useEnvironmentServerConfig(environmentId);
  const state = useD4AgentState(environmentId, config?.settings.d4Agent.enabled === true);
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
          if (state.data?.threadId && !allowed) {
            if (!(await waitForAgentThread(environmentId, state.data.threadId))) {
              setError(true);
              return;
            }
            linkTo(
              `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(state.data.threadId)}`,
            );
            return;
          }
          setOpening(true);
          setError(false);
          await ensure({ environmentId, input: {} })
            .then(async (result) => {
              if (
                result._tag === "Success" &&
                (await waitForAgentThread(environmentId, result.value.threadId))
              )
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
  const identity = useEnvironmentQuery(
    config?.settings.d4Agent.enabled
      ? serverEnvironment.d4AgentIdentity({ environmentId, input: {} })
      : null,
  );
  return config?.settings.d4Agent.enabled && identity.data?.threadId === threadId ? (
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
  const query = useD4AgentState(environmentId);
  const config = useEnvironmentServerConfig(environmentId);
  const switchContext = useAtomCommand(serverEnvironment.switchD4AgentContext);
  const canSwitch = useAtomValue(
    serverEnvironment.switchD4AgentContext.permissionAtom(environmentId),
  );
  const [choosingContext, setChoosingContext] = useState(false);
  const [switching, setSwitching] = useState(false);
  const threads = useThreadShells();
  const linkTo = useLinkTo();
  const resolve = useAtomCommand(serverEnvironment.resolveD4AgentAction);
  const allowed = useAtomValue(
    serverEnvironment.resolveD4AgentAction.permissionAtom(environmentId),
  );
  const monitorEnabled = config?.settings.agentMonitor.enabled === true;
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
            thread.deletedAt === null &&
            projectBelongsToAgentContext(
              thread.projectId,
              state.brainContext,
              config?.settings.d4Agent.projectContexts ?? {},
            ),
        ),
      )
    : [];
  return (
    <View className="max-h-64 border-b border-border bg-surface">
      <Modal
        visible={choosingContext}
        transparent
        animationType="none"
        onRequestClose={() => setChoosingContext(false)}
      >
        <View className="flex-1 justify-center bg-background px-6">
          <Text className="mb-3 text-lg font-t3-semibold text-foreground">Agent context</Text>
          {D4_BRAIN_CONTEXTS.map((context) => (
            <Pressable
              key={context}
              accessibilityRole="radio"
              accessibilityState={{
                checked: context === state.brainContext,
                disabled: switching || !canSwitch,
              }}
              disabled={switching || !canSwitch}
              className="rounded-xl bg-surface px-4 py-4"
              onPress={async () => {
                setChoosingContext(false);
                if (context === state.brainContext) return;
                setSwitching(true);
                setActionError(null);
                await switchContext({ environmentId, input: { context } })
                  .then(async (result) => {
                    if (
                      result._tag === "Failure" ||
                      !(await waitForAgentThread(environmentId, result.value.threadId))
                    )
                      setActionError("Could not switch context.");
                    else
                      linkTo(
                        `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(result.value.threadId)}`,
                      );
                  })
                  .catch(() => setActionError("Could not switch context."))
                  .finally(() => setSwitching(false));
              }}
            >
              <Text className="text-base text-foreground">
                {context}
                {context === state.brainContext ? " ✓" : ""}
              </Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="button"
            className="p-4"
            onPress={() => setChoosingContext(false)}
          >
            <Text className="text-accent">Cancel</Text>
          </Pressable>
        </View>
      </Modal>
      <ScrollView contentContainerClassName="gap-2 px-4 py-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Agent context"
          accessibilityState={{ disabled: !canSwitch || switching }}
          disabled={!canSwitch || switching}
          className="self-start rounded-full border border-border px-3 py-2"
          onPress={() => setChoosingContext(true)}
        >
          <Text className="text-sm text-accent">
            {switching ? "Switching context…" : `Context · ${state.brainContext}`}
          </Text>
        </Pressable>
        {state.contextChangedAt ? (
          <Text
            accessibilityRole="text"
            className="border-b border-border pb-2 text-xs text-foreground-muted"
          >
            Context changed to {state.brainContext}. New session.
          </Text>
        ) : null}
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
        {state.actionLog
          .filter((record) => record.status === "pending")
          .map((record) => (
            <AgentActionRecord
              key={record.id}
              environmentId={environmentId}
              record={record}
              allowed={allowed}
              busy={busy}
              onResolve={async (decision) => {
                setBusy(true);
                setActionError(null);
                await resolve({ environmentId, input: { actionId: record.id, decision } })
                  .then((result) => {
                    if (result._tag === "Failure") setActionError("Could not resolve this action.");
                    query.refresh();
                  })
                  .catch(() => setActionError("Could not resolve this action."))
                  .finally(() => setBusy(false));
              }}
            />
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
              ? state.actionLog
                  .filter((record) => record.status !== "pending")
                  .slice(0, 20)
                  .map((record) => (
                    <AgentActionRecord
                      key={record.id}
                      environmentId={environmentId}
                      record={record}
                      allowed={allowed}
                      busy={busy}
                      onResolve={async () => undefined}
                    />
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

function AgentActionRecord({
  environmentId,
  record,
  allowed,
  busy,
  onResolve,
}: {
  environmentId: EnvironmentId;
  record: D4AgentActionSummary;
  allowed: boolean;
  busy: boolean;
  onResolve: (decision: "approve" | "deny") => Promise<void>;
}) {
  const [reviewing, setReviewing] = useState(false);
  const detail = useEnvironmentQuery(
    reviewing
      ? serverEnvironment.d4AgentAction({ environmentId, input: { actionId: record.id } })
      : null,
  );
  const canApprove =
    allowed && !busy && detail.data?.id === record.id && detail.data.status === "pending";
  return (
    <View className="gap-2 py-2">
      <Text className="text-sm text-foreground">
        {record.createdAt} · {record.type} · {record.targetId} · {record.status}
      </Text>
      <Text className="text-sm text-foreground-muted">{record.preview}</Text>
      <Pressable accessibilityRole="button" onPress={() => setReviewing(!reviewing)}>
        <Text className="text-accent">{reviewing ? "Hide action details" : "Review action"}</Text>
      </Pressable>
      {reviewing && detail.data ? (
        <Text className="text-xs text-foreground-muted">
          {JSON.stringify(
            {
              context: detail.data.context,
              action: detail.data.action,
              result: detail.data.result,
            },
            null,
            2,
          )}
        </Text>
      ) : null}
      {detail.error ? <Text accessibilityRole="alert">{detail.error}</Text> : null}
      {record.status === "pending" ? (
        <View className="flex-row gap-4">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !canApprove }}
            disabled={!canApprove}
            onPress={() => void onResolve("approve")}
          >
            <Text className="text-accent">Approve</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!allowed || busy}
            onPress={() => void onResolve("deny")}
          >
            <Text className="text-accent">Deny</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
