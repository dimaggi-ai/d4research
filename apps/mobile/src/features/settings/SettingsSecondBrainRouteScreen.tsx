import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { BrainLintIssue, EnvironmentId, SecondBrainSettings } from "@d4research/contracts";
import {
  refreshSecondBrain,
  secondBrainStatusQuery,
  secondBrainProposalsQuery,
  secondBrainProposalQuery,
  secondBrainAcceptCommand,
  secondBrainRejectCommand,
  secondBrainReindexCommand,
  secondBrainLintCommand,
  secondBrainRegenerateIndexCommand,
} from "../../state/second-brain";
import { useCallback, useContext, useRef, useState } from "react";
import { View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsChoiceRow } from "./components/SettingsChoiceRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

export function SettingsSecondBrainRouteScreen() {
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Second brain" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 py-4"
          contentContainerStyle={{ paddingBottom: 48 }}
        >
          {selectedProjectKey !== null ? (
            <Text>Select All projects to manage environment-wide second brain settings.</Text>
          ) : selectedTargets.length === 0 ? (
            <Text>Select a connected environment.</Text>
          ) : (
            selectedTargets.map((target) => (
              <EnvironmentBrain key={target.environmentId} target={target} />
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

function BrainField({
  label,
  value,
  disabled,
  onSave,
  number = false,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onSave: (value: string) => void;
  number?: boolean;
}) {
  const edited = useRef(false);
  return (
    <View className="gap-2 px-4 py-3">
      <Text>{label}</Text>
      <AppTextInput
        key={value}
        accessibilityLabel={label}
        defaultValue={value}
        editable={!disabled}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={number ? "number-pad" : "default"}
        className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
        onChangeText={() => {
          edited.current = true;
        }}
        onEndEditing={(event) => {
          if (edited.current && event.nativeEvent.text.trim() !== value)
            onSave(event.nativeEvent.text.trim());
          edited.current = false;
        }}
      />
    </View>
  );
}

function EnvironmentBrain({ target }: { target: SettingsTarget }) {
  const environmentId = target.environmentId;
  const settings = target.serverConfig.settings.secondBrain;
  const canWrite = useAtomValue(secondBrainReindexCommand.permissionAtom(environmentId));
  const canReindex = useAtomValue(secondBrainReindexCommand.permissionAtom(environmentId));
  const canRegenerate = useAtomValue(
    secondBrainRegenerateIndexCommand.permissionAtom(environmentId),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const reindex = useAtomCommand(secondBrainReindexCommand);
  const lint = useAtomCommand(secondBrainLintCommand);
  const regenerate = useAtomCommand(secondBrainRegenerateIndexCommand);
  const status = useEnvironmentQuery(secondBrainStatusQuery(environmentId));
  const registry = useContext(RegistryContext);
  const refreshStatus = useCallback(
    () => refreshSecondBrain(environmentId, registry),
    [environmentId, registry],
  );
  useFocusEffect(
    useCallback(() => {
      refreshStatus();
    }, [refreshStatus]),
  );
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [lintTruncated, setLintTruncated] = useState(false);
  const [issues, setIssues] = useState<readonly BrainLintIssue[] | null>(null);
  const [inbox, setInbox] = useState(false);
  const run = async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    await operation().finally(() => {
      busyRef.current = false;
      setBusy(false);
    });
  };
  const write = (patch: Partial<SecondBrainSettings>) =>
    void run(async () => {
      const result = await update({ environmentId, input: { patch: { secondBrain: patch } } });
      if (result._tag !== "Success") setError("Could not save second brain settings.");
      refreshStatus();
    });
  const disabled = !canWrite || busy;
  const integer = (value: string, max: number, apply: (value: number) => void, min = 0) => {
    const parsed = Number(value);
    if (value === "" || !Number.isInteger(parsed) || parsed < min || parsed > max) {
      setError(`Enter a whole number from ${min} to ${max}.`);
      return;
    }
    apply(parsed);
  };
  return (
    <View className="gap-6">
      <SettingsSection title={target.label}>
        <BrainField
          label="Folder on this environment"
          value={settings.path}
          disabled={disabled}
          onSave={(path) => write({ path })}
        />
        <SettingsSwitchRow
          label="Inject brain context"
          value={settings.injection.enabled}
          disabled={disabled}
          onValueChange={(enabled) => write({ injection: { ...settings.injection, enabled } })}
        />
        <BrainField
          label="Core budget (characters)"
          value={String(settings.injection.coreBudgetChars)}
          disabled={disabled}
          number
          onSave={(value) =>
            integer(value, 262144, (coreBudgetChars) =>
              write({ injection: { ...settings.injection, coreBudgetChars } }),
            )
          }
        />
        <BrainField
          label="Retrieval budget (characters)"
          value={String(settings.injection.retrievalBudgetChars)}
          disabled={disabled}
          number
          onSave={(value) =>
            integer(value, 262144, (retrievalBudgetChars) =>
              write({ injection: { ...settings.injection, retrievalBudgetChars } }),
            )
          }
        />
        <BrainField
          label="Retrieval results"
          value={String(settings.injection.retrievalResults)}
          disabled={disabled}
          number
          onSave={(value) =>
            integer(
              value,
              50,
              (retrievalResults) =>
                write({ injection: { ...settings.injection, retrievalResults } }),
              1,
            )
          }
        />
      </SettingsSection>
      <SettingsSection title="Capture">
        <SettingsChoiceRow
          label="Off"
          selected={settings.capture === "off"}
          disabled={disabled}
          onPress={() => write({ capture: "off" })}
        />
        <SettingsChoiceRow
          label="Propose notes after successful turns"
          selected={settings.capture === "proposals"}
          disabled={disabled}
          onPress={() => write({ capture: "proposals" })}
        />
        <BrainField
          label="Capture model (blank uses handoff model)"
          value={settings.captureModel ?? ""}
          disabled={disabled}
          onSave={(captureModel) => write({ captureModel })}
        />
      </SettingsSection>
      <SettingsSection title="Write mode">
        <SettingsChoiceRow
          label="Review proposals"
          selected={settings.writeMode === "review"}
          disabled={disabled}
          onPress={() => write({ writeMode: "review" })}
        />
        <SettingsChoiceRow
          label="Allow direct agent writes"
          selected={settings.writeMode === "direct"}
          disabled={disabled}
          onPress={() => write({ writeMode: "direct" })}
        />
      </SettingsSection>
      <SettingsSection title="Embeddings">
        <SettingsSwitchRow
          label="Enable local embeddings"
          value={settings.embeddings.enabled}
          disabled={disabled}
          onValueChange={(enabled) => write({ embeddings: { ...settings.embeddings, enabled } })}
        />
        <BrainField
          label="Embedding model"
          value={settings.embeddings.model}
          disabled={disabled}
          onSave={(model) => write({ embeddings: { ...settings.embeddings, model } })}
        />
      </SettingsSection>
      <SettingsSection title="Index">
        {status.data ? (
          <View className="gap-2 p-4">
            <Text>
              {status.data.notes} notes · {status.data.chunks} chunks
            </Text>
            <Text>Last reconcile: {status.data.lastIndexedAt ?? "Never"}</Text>
            <Text>Semantic status: {status.data.semanticStatus}</Text>
            <Text>Pending capture jobs: {status.data.captureJobs?.pending ?? 0}</Text>
            <Text>Failed capture jobs: {status.data.captureJobs?.failed ?? 0}</Text>
            <Text>Generation: {status.data.generation}</Text>
            {status.data.truncated ? <Text>Index is truncated.</Text> : null}
          </View>
        ) : (
          <Text>{status.error ?? "Loading index status…"}</Text>
        )}
        <SettingsActionRow
          label="Reindex"
          disabled={!canReindex || busy}
          onPress={() =>
            void run(async () => {
              const result = await reindex({ environmentId, input: {} });
              if (result._tag !== "Success") setError("Reindex failed.");
              refreshStatus();
            })
          }
        />
        <SettingsActionRow
          label="Lint"
          disabled={busy}
          onPress={() =>
            void run(async () => {
              const result = await lint({ environmentId, input: {} });
              if (result._tag === "Success") {
                setIssues(result.value.issues);
                setLintTruncated(result.value.truncated);
              } else setError("Lint failed.");
            })
          }
        />
        <SettingsActionRow
          label="Regenerate INDEX"
          disabled={!canRegenerate || busy}
          onPress={() =>
            void run(async () => {
              const result = await regenerate({ environmentId, input: {} });
              if (result._tag !== "Success") setError("Index regeneration failed.");
              refreshStatus();
            })
          }
        />
        {lintTruncated ? <Text>Lint results are truncated.</Text> : null}
        {issues !== null ? (
          <View className="gap-2 p-4">
            {issues.length === 0 ? (
              <Text>No lint issues.</Text>
            ) : (
              issues.map((issue) => (
                <Text key={`${issue.path}:${issue.code}:${issue.line ?? 0}`}>
                  {issue.path}
                  {issue.line ? `:${issue.line}` : ""} — {issue.code}
                </Text>
              ))
            )}
          </View>
        ) : null}
      </SettingsSection>
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      <SettingsSection title="Review">
        <SettingsActionRow
          label={inbox ? "Hide review inbox" : "Open review inbox"}
          onPress={() => setInbox(!inbox)}
        />
      </SettingsSection>
      {inbox ? <BrainInbox environmentId={environmentId} /> : null}
    </View>
  );
}

function BrainInbox({ environmentId }: { environmentId: EnvironmentId }) {
  const [offset, setOffset] = useState(0);
  const [state, setState] = useState<"pending" | "conflict">("pending");
  const [selected, setSelected] = useState<string | null>(null);
  const proposals = useEnvironmentQuery(
    secondBrainProposalsQuery({ environmentId, state, offset, limit: 20 }),
  );
  const refresh = proposals.refresh;
  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );
  const navigation = useNavigation();
  return (
    <SettingsSection title="Review inbox">
      <SettingsChoiceRow
        label="Pending"
        selected={state === "pending"}
        onPress={() => {
          setState("pending");
          setOffset(0);
          setSelected(null);
        }}
      />
      <SettingsChoiceRow
        label="Conflicts"
        selected={state === "conflict"}
        onPress={() => {
          setState("conflict");
          setOffset(0);
          setSelected(null);
        }}
      />
      <SettingsActionRow label="Refresh inbox" onPress={refresh} />
      {proposals.isPending ? <Text>Loading proposals…</Text> : null}
      {proposals.error ? <Text>{proposals.error}</Text> : null}
      {proposals.data?.map((proposal) => (
        <View key={proposal.id}>
          <SettingsActionRow
            label={proposal.path}
            description={`${proposal.kind} · ${new Date(proposal.createdAt).toLocaleString()}`}
            onPress={() => setSelected(proposal.id)}
          />
          {proposal.evidence[0] ? (
            <SettingsActionRow
              label="Source thread"
              onPress={() =>
                navigation.navigate("Thread", {
                  environmentId,
                  threadId: proposal.evidence[0]!.threadId,
                })
              }
            />
          ) : null}
        </View>
      ))}
      {proposals.data?.length === 0 ? <Text>No proposals.</Text> : null}
      <SettingsActionRow
        label="Previous page"
        disabled={offset === 0}
        onPress={() => {
          setOffset(Math.max(0, offset - 20));
          setSelected(null);
        }}
      />
      <SettingsActionRow
        label="Next page"
        disabled={(proposals.data?.length ?? 0) < 20}
        onPress={() => {
          setOffset(offset + 20);
          setSelected(null);
        }}
      />
      {selected ? (
        <ProposalDetail
          key={selected}
          environmentId={environmentId}
          id={selected}
          onReviewed={() => {
            setSelected(null);
            refresh();
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

function ProposalDetail({
  environmentId,
  id,
  onReviewed,
}: {
  environmentId: EnvironmentId;
  id: string;
  onReviewed: () => void;
}) {
  const detail = useEnvironmentQuery(secondBrainProposalQuery({ environmentId, id }));
  const canAccept = useAtomValue(secondBrainAcceptCommand.permissionAtom(environmentId));
  const canReject = useAtomValue(secondBrainRejectCommand.permissionAtom(environmentId));
  const accept = useAtomCommand(secondBrainAcceptCommand);
  const reject = useAtomCommand(secondBrainRejectCommand);
  const navigation = useNavigation();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const data = detail.data;
  const reviewable =
    !data || data.proposal.state === "pending" || data.proposal.state === "conflict";
  const review = async (action: "accept" | "reject") => {
    if (
      busyRef.current ||
      !reviewable ||
      (action === "accept" && (!data || data.conflict || data.truncated))
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const request =
      action === "accept"
        ? accept({ environmentId, input: { id, expectedHash: data!.currentHash } })
        : reject({ environmentId, input: { id, reason: reason.trim() } });
    const result = await request.finally(() => {
      busyRef.current = false;
      setBusy(false);
    });
    if (result._tag === "Success") onReviewed();
    else {
      setError("Review failed. Refresh the proposal and try again.");
      detail.refresh();
    }
  };
  if (!data)
    return (
      <View className="gap-3 p-4">
        <Text>{detail.error ?? "Loading proposal…"}</Text>
        <AppTextInput
          accessibilityLabel="Rejection reason"
          placeholder="Rejection reason"
          value={reason}
          onChangeText={setReason}
          editable={!busy && canReject}
          multiline
          className="min-h-16 px-3 py-2 text-base text-foreground"
        />
        <SettingsActionRow
          label="Reject proposal"
          tone="danger"
          disabled={!canReject || busy || !reason.trim()}
          onPress={() => void review("reject")}
        />
        {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      </View>
    );
  return (
    <View className="gap-3 p-4">
      <Text>{data.proposal.path}</Text>
      <Text>{data.proposal.rationale}</Text>
      {!reviewable ? <Text>This proposal has already been reviewed.</Text> : null}
      {data.conflict ? (
        <Text accessibilityRole="alert">
          The file changed since this proposal was created. Reject this proposal and ask the agent
          to propose against the current file.
        </Text>
      ) : null}
      {data.truncated ? (
        <Text accessibilityRole="alert">
          The diff exceeds the display limit. Acceptance is disabled.
        </Text>
      ) : null}
      <Text selectable className="font-mono text-sm text-foreground">
        {data.diff}
      </Text>
      {data.proposal.possibleDuplicates?.map((duplicate) => (
        <Text key={duplicate.path}>
          Possible duplicate: {duplicate.path} — {duplicate.reason}
        </Text>
      ))}
      {data.proposal.evidence.map((evidence) => (
        <View key={`${evidence.threadId}:${evidence.messageId}:${evidence.quote}`}>
          <Text selectable>{evidence.quote}</Text>
          <SettingsActionRow
            label={`Source message ${evidence.messageId}`}
            onPress={() =>
              navigation.navigate("Thread", {
                environmentId,
                threadId: evidence.threadId,
                messageId: evidence.messageId,
              })
            }
          />
        </View>
      ))}
      <SettingsActionRow
        label="Accept proposal"
        disabled={!canAccept || !reviewable || busy || data.conflict || data.truncated}
        onPress={() => void review("accept")}
      />
      <AppTextInput
        accessibilityLabel="Rejection reason"
        placeholder="Rejection reason"
        value={reason}
        onChangeText={setReason}
        editable={!busy && canReject}
        multiline
        className="min-h-16 px-3 py-2 text-base text-foreground"
      />
      <SettingsActionRow
        label="Reject proposal"
        tone="danger"
        disabled={!canReject || !reviewable || busy || !reason.trim()}
        onPress={() => void review("reject")}
      />
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
    </View>
  );
}
