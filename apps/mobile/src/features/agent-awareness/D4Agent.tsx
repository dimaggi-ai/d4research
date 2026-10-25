import { D4AgentSessions } from "./D4AgentSessions";
import * as Clipboard from "expo-clipboard";
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
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { Pressable, View, ScrollView, Modal, TextInput } from "react-native";
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

export function D4AgentHomeHeader({
  environments,
  selectedEnvironmentId,
  children,
}: {
  environments: ReadonlyArray<{ environmentId: EnvironmentId; label: string }>;
  selectedEnvironmentId: EnvironmentId | null;
  children?: ReactNode;
}) {
  return (
    <>
      {environments
        .filter(
          (environment) =>
            selectedEnvironmentId === null || environment.environmentId === selectedEnvironmentId,
        )
        .map((environment) => (
          <D4AgentEntry
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environments.length > 1 ? environment.label : undefined}
          />
        ))}
      {children}
    </>
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
        className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-3"
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
  const newSession = useAtomCommand(serverEnvironment.newD4AgentSession);
  const canStartSession = useAtomValue(
    serverEnvironment.newD4AgentSession.permissionAtom(environmentId),
  );
  const resolveProposal = useAtomCommand(serverEnvironment.resolveD4AgentMemoryProposal);
  const canResolveProposal = useAtomValue(
    serverEnvironment.resolveD4AgentMemoryProposal.permissionAtom(environmentId),
  );
  const [startingSession, setStartingSession] = useState(false);
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
  const proposals = (state.memoryProposals ?? []).filter(
    (proposal) => proposal.context === state.brainContext,
  );
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
                disabled: switching || startingSession || !canSwitch,
              }}
              disabled={switching || startingSession || !canSwitch}
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
          accessibilityState={{ disabled: !canSwitch || switching || startingSession }}
          disabled={!canSwitch || switching || startingSession}
          className="self-start rounded-full border border-border px-3 py-2"
          onPress={() => setChoosingContext(true)}
        >
          <Text className="text-sm text-accent">
            {switching ? "Switching context…" : `Context · ${state.brainContext}`}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canStartSession || switching || startingSession }}
          disabled={!canStartSession || switching || startingSession}
          className="self-start rounded-full border border-border px-3 py-2"
          onPress={async () => {
            setStartingSession(true);
            setActionError(null);
            await newSession({ environmentId, input: {} })
              .then(async (result) => {
                if (
                  result._tag === "Failure" ||
                  !(await waitForAgentThread(environmentId, result.value.threadId))
                )
                  setActionError("Could not start a new session.");
                else
                  linkTo(
                    `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(result.value.threadId)}`,
                  );
              })
              .catch(() => setActionError("Could not start a new session."))
              .finally(() => setStartingSession(false));
          }}
        >
          <Text className="text-sm text-accent">
            {startingSession ? "Starting session…" : "New session"}
          </Text>
        </Pressable>
        <D4AgentSessions
          environmentId={environmentId}
          sessions={state.openSessions ?? []}
          refresh={query.refresh}
        />
        {state.sessionChangeReason ? (
          <Text
            accessibilityRole="text"
            className="border-b border-border pb-2 text-xs text-foreground-muted"
          >
            {state.sessionChangeReason === "resumed"
              ? `Resumed ${state.brainContext} session.`
              : state.sessionChangeReason === "size"
                ? "Session size budget reached. New session."
                : state.sessionChangeReason === "new-session"
                  ? "New session."
                  : `Context changed to ${state.brainContext}. New session.`}
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
        {state.ctoAskInFlight ? (
          <Text className="text-sm text-foreground-muted">CTO question in progress.</Text>
        ) : null}
        {proposals.length > 0 ? (
          <View className="gap-2 py-2">
            <Text className="font-t3-semibold text-foreground">
              Memory proposals · {proposals.length}
            </Text>
            {proposals.map((proposal) => (
              <View key={proposal.id} className="gap-2 rounded border border-border p-2">
                <Text className="text-xs text-foreground-muted">
                  {proposal.context} · {proposal.createdAt ?? "Creation time unavailable"} ·{" "}
                  {proposal.status}
                </Text>
                <Text selectable className="text-sm text-foreground">
                  {proposal.text}
                </Text>
                {proposal.status === "pending" ? (
                  <View className="flex-row gap-4">
                    {[true, false].map((approve) => (
                      <Pressable
                        key={String(approve)}
                        accessibilityRole="button"
                        accessibilityState={{ disabled: !canResolveProposal || busy }}
                        disabled={!canResolveProposal || busy}
                        onPress={async () => {
                          setBusy(true);
                          setActionError(null);
                          await resolveProposal({
                            environmentId,
                            input: { proposalId: proposal.id, approve },
                          })
                            .then((result) => {
                              if (result._tag === "Failure")
                                setActionError("Could not review this memory proposal.");
                              query.refresh();
                            })
                            .catch(() => setActionError("Could not review this memory proposal."))
                            .finally(() => setBusy(false));
                        }}
                      >
                        <Text className="text-accent">{approve ? "Approve" : "Reject"}</Text>
                      </Pressable>
                    ))}
                  </View>
                ) : proposal.status === "approved" ? (
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      void Clipboard.setStringAsync(proposal.text).catch(() =>
                        setActionError(
                          "Could not copy this memory proposal. Select the text to copy it.",
                        ),
                      );
                    }}
                  >
                    <Text className="text-accent">Copy text</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}
        {(state.otherContextProposalCounts ?? []).map(({ context, count }) => (
          <Text key={context} className="text-xs text-foreground-muted">
            Pending memory proposals · {context}: {count}
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
              onResolve={async (decision, options) => {
                setBusy(true);
                setActionError(null);
                await resolve({
                  environmentId,
                  input: { actionId: record.id, decision, ...options },
                })
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
  onResolve: (
    decision: "approve" | "deny",
    options?: { editedText?: string; sendOriginal?: boolean },
  ) => Promise<void>;
}) {
  const undoArchive = useAtomCommand(serverEnvironment.undoD4AgentArchive);
  const canUndoArchive = useAtomValue(
    serverEnvironment.undoD4AgentArchive.permissionAtom(environmentId),
  );
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState<string | null>(null);
  const detail = useEnvironmentQuery(
    reviewing
      ? serverEnvironment.d4AgentAction({ environmentId, input: { actionId: record.id } })
      : null,
  );
  const refreshDetail = useEffectEvent(detail.refresh);
  const previousResolution = useRef({ status: record.status, resolvedAt: record.resolvedAt });
  useEffect(() => {
    if (
      reviewing &&
      (previousResolution.current.status !== record.status ||
        previousResolution.current.resolvedAt !== record.resolvedAt)
    )
      refreshDetail();
    previousResolution.current = { status: record.status, resolvedAt: record.resolvedAt };
  }, [record.status, record.resolvedAt, reviewing]);
  const canApprove =
    allowed && !busy && detail.data?.id === record.id && detail.data.status === "pending";
  const sendAction = detail.data?.action.type === "send" ? detail.data.action : null;
  const finalText = editedText ?? sendAction?.text ?? "";
  const launchAction =
    detail.data &&
    (detail.data.action.type === "research" ||
      detail.data.action.type === "pipeline" ||
      detail.data.action.type === "start")
      ? detail.data.action
      : null;
  return (
    <View className="gap-2 py-2">
      <Text className="text-sm text-foreground">
        {record.createdAt} · {record.type} · {record.targetId} · {record.status}
      </Text>
      <Text className="text-sm text-foreground-muted">{record.preview}</Text>
      <Pressable accessibilityRole="button" onPress={() => setReviewing(!reviewing)}>
        <Text className="text-accent">{reviewing ? "Hide action details" : "Review action"}</Text>
      </Pressable>
      {reviewing && detail.data && !sendAction && !launchAction ? (
        <Text className="text-xs text-foreground-muted">
          {JSON.stringify(
            {
              context: detail.data.context,
              action: detail.data.action,
              ...(typeof detail.data.result === "string" ? {} : { result: detail.data.result }),
            },
            null,
            2,
          )}
        </Text>
      ) : null}
      {reviewing && typeof detail.data?.result === "string" ? (
        <Text selectable className="text-xs text-foreground-muted">
          {detail.data.result}
        </Text>
      ) : null}
      {reviewing && launchAction ? (
        <View className="gap-2 rounded border border-border p-3">
          <Text className="text-xs text-foreground-muted">
            Target project · {launchAction.projectId}
          </Text>
          {launchAction.type !== "start" ? (
            <Text className="text-xs text-foreground-muted">
              Pipeline · {launchAction.pipelineId}
            </Text>
          ) : null}
          <Text className="text-xs text-foreground-muted">
            Model · {launchAction.modelSelection.instanceId} / {launchAction.modelSelection.model}
          </Text>
          <Text className="text-xs text-foreground-muted">Final prompt</Text>
          <Text selectable className="text-sm text-foreground">
            {launchAction.text}
          </Text>
        </View>
      ) : null}
      {reviewing && sendAction ? (
        <View className="gap-2 rounded border border-border p-3">
          <Text className="text-xs text-foreground-muted">Original</Text>
          <Text selectable className="text-sm text-foreground">
            {sendAction.originalText ?? sendAction.text}
          </Text>
          <Text className="text-xs text-foreground-muted">Rewritten prompt</Text>
          {editing ? (
            <TextInput
              accessibilityLabel="Edit rewritten prompt"
              multiline
              value={finalText}
              onChangeText={setEditedText}
              className="min-h-24 rounded border border-border p-3 text-foreground"
            />
          ) : (
            <Text selectable className="text-sm text-foreground">
              {finalText}
            </Text>
          )}
          {record.status === "pending" ? (
            <Pressable
              accessibilityRole="button"
              disabled={!canApprove}
              onPress={() => setEditing(!editing)}
            >
              <Text className="text-accent">{editing ? "Done editing" : "Edit"}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {detail.error ? <Text accessibilityRole="alert">{detail.error}</Text> : null}
      {record.type === "auto-archive" && record.status === "executed" ? (
        <Pressable
          accessibilityRole="button"
          disabled={!canUndoArchive || undoing}
          onPress={async () => {
            setUndoing(true);
            setUndoError(false);
            try {
              const result = await undoArchive({ environmentId, input: { actionId: record.id } });
              if (result._tag === "Failure") setUndoError(true);
              else refreshDetail();
            } catch {
              setUndoError(true);
            }
            setUndoing(false);
          }}
        >
          <Text className="text-accent">{undoing ? "Restoring…" : "Undo archive"}</Text>
        </Pressable>
      ) : null}
      {undoError ? <Text accessibilityRole="alert">Could not restore this thread.</Text> : null}
      {record.status === "pending" ? (
        <View className="flex-row gap-4">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !canApprove }}
            disabled={!canApprove || (sendAction !== null && !finalText.trim())}
            onPress={() =>
              void onResolve(
                "approve",
                sendAction && editedText !== null ? { editedText } : undefined,
              )
            }
          >
            <Text className="text-accent">{sendAction ? "Send" : "Approve"}</Text>
          </Pressable>
          {sendAction?.originalText ? (
            <Pressable
              accessibilityRole="button"
              disabled={!canApprove}
              onPress={() => void onResolve("approve", { sendOriginal: true })}
            >
              <Text className="text-accent">Send original</Text>
            </Pressable>
          ) : null}
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
