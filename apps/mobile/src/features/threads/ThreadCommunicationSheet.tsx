import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@d4research/contracts";
import { scopeThreadRef } from "@d4research/client-runtime/environment";
import {
  communicationDetailRefs,
  communicationStatusLabel,
  communicationStatusTone,
  communicationThreadKey,
  deriveThreadCommunication,
  retainThreadCommunication,
  recentCommunicationParticipants,
  type ThreadCommunication,
  selectCommunicationMessages,
  type CommunicationSelection,
} from "@d4research/client-runtime/state/thread-communication";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useEnvironments } from "../../state/environments";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useAtomCommand } from "../../state/use-atom-command";

const statusClasses = {
  working: "text-adaptive-sky-600-400",
  monitoring: "text-adaptive-blue-600-400",
  done: "text-adaptive-emerald-700-300",
  failed: "text-danger-foreground",
  input: "text-adaptive-indigo-600-300",
  attention: "text-warning-foreground",
  neutral: "text-foreground-muted",
};

const sourcesAtom = Atom.family((key: string) => {
  const pairs = JSON.parse(key) as ReadonlyArray<readonly [string, string]>;
  return Atom.make((get) =>
    pairs.map(([env, thread]) => {
      const ref = scopeThreadRef(EnvironmentId.make(env), ThreadId.make(thread));
      return {
        ref,
        thread: get(environmentThreadDetails.threadAtom(ref)),
        error: get(environmentThreadDetails.errorAtom(ref)),
        history: get(environmentThreadDetails.historyAtom(ref)),
      };
    }),
  ).pipe(Atom.setIdleTTL(0));
});

export function ThreadCommunicationSheet({ route }: StaticScreenProps<ScopedThreadRef>) {
  const target = route.params;
  const shells = useAtomValue(environmentThreadShells.threadShellsAtom);
  let root = target;
  const seen = new Set<string>();
  for (let depth = 0; depth < 16; depth++) {
    const key = communicationThreadKey(root);
    if (seen.has(key)) break;
    seen.add(key);
    const shell = shells.find(
      (s) => s.environmentId === root.environmentId && s.id === root.threadId,
    );
    if (
      shell?.source.lineage.relationshipToParent !== "subagent" ||
      shell.source.lineage.parentThreadId === null
    )
      break;
    root = scopeThreadRef(root.environmentId, shell.source.lineage.parentThreadId);
  }
  const [selection, setSelection] = useState<CommunicationSelection>(() =>
    communicationThreadKey(root) === communicationThreadKey(target)
      ? { kind: "all" }
      : { kind: "participant", id: communicationThreadKey(target) },
  );
  const [refs, setRefs] = useState<ReadonlyArray<ScopedThreadRef>>(() =>
    communicationThreadKey(root) === communicationThreadKey(target) ? [] : [target],
  );
  const [readingMode, setReadingMode] = useState<"compact" | "preview" | "full">("preview");
  const [readingRevision, setReadingRevision] = useState(0);
  const [mapOpen, setMapOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(30);
  const { environments } = useEnvironments();
  const labels = useMemo(
    () => new Map(environments.map((e) => [e.environmentId, e.label])),
    [environments],
  );
  const sources = useAtomValue(
    sourcesAtom(JSON.stringify([root, ...refs].map((ref) => [ref.environmentId, ref.threadId]))),
  );
  const currentModel = useMemo(
    () =>
      deriveThreadCommunication({
        root: { environmentId: root.environmentId, threadId: root.threadId },
        threads: sources.flatMap((s) => (s.thread === null ? [] : [s.thread])),
        environmentLabels: labels,
      }),
    [root.environmentId, root.threadId, sources, labels],
  );
  const [retained, setRetained] = useState<ThreadCommunication | null>(null);
  useEffect(() => {
    setRetained((previous) => retainThreadCommunication(previous, currentModel));
  }, [currentModel]);
  const model = useMemo(
    () => retainThreadCommunication(retained, currentModel),
    [retained, currentModel],
  );
  const orderedParticipants = useMemo(() => recentCommunicationParticipants(model), [model]);
  const messages = selectCommunicationMessages(model, selection);
  const participants = new Map(model.participants.map((p) => [p.id, p]));
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const loadEarlier = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    reportFailure: false,
  });
  const history = sources.find((s) => s.history.hasMoreHistory);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const select = (next: CommunicationSelection) => {
    const nextRefs = communicationDetailRefs(model, next).filter(
      (ref) => communicationThreadKey(ref) !== model.rootId,
    );
    if (next.kind === "all" || nextRefs.length > 0) setRefs(nextRefs);
    setSelection(next);
    setVisibleCount(30);
  };
  const selected = selection.kind === "participant" ? participants.get(selection.id) : undefined;
  return (
    <View className="flex-1 bg-sheet">
      <View className="flex-row items-center justify-between gap-2 px-4 pt-4 pb-2">
        <Text className="flex-1 text-lg font-t3-medium">Agent communication</Text>
        <Button label="Close" tone="text" onPress={() => navigation.goBack()} />
      </View>
      <ScrollView
        horizontal
        className="max-h-16 shrink-0 border-b border-border"
        contentContainerClassName="gap-2 px-4 py-2"
      >
        <Button
          label="Overview"
          tone={selection.kind === "all" ? "primary" : "secondary"}
          onPress={() => select({ kind: "all" })}
        />
        {orderedParticipants
          .filter((p) => p.id !== model.rootId)
          .map((p) => (
            <Button
              key={p.id}
              label={p.label}
              tone={selected?.id === p.id ? "primary" : "secondary"}
              onPress={() => select({ kind: "participant", id: p.id })}
            />
          ))}
      </ScrollView>
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-4 py-3"
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
      >
        <Button
          label={mapOpen ? "Hide connection map" : "Show connection map"}
          tone="text"
          onPress={() => setMapOpen(!mapOpen)}
        />
        {mapOpen ? (
          <View className="gap-2 rounded-2xl border border-border p-3">
            <Text className="font-t3-medium">Who’s coordinating</Text>
            {model.participants.slice(0, 8).map((p) => (
              <Pressable
                key={p.id}
                accessibilityRole="button"
                onPress={() => select({ kind: "participant", id: p.id })}
                className="rounded-xl bg-muted p-3"
              >
                <Text className="text-sm font-t3-medium">{p.label}</Text>
                <Text className="text-xs text-foreground-muted">
                  {p.environmentLabel} ·{" "}
                  <Text className={statusClasses[communicationStatusTone(p.status)]}>
                    {communicationStatusLabel(p.status)}
                  </Text>
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {exchangeCount(
                    model.messages.filter((m) => m.from === p.id || m.to === p.id).length,
                  )}
                </Text>
              </Pressable>
            ))}
            {model.messages.length > 0 ? (
              <Text className="text-xs text-foreground-muted">Connections</Text>
            ) : null}
            {[...new Map(model.messages.map((m) => [[m.from, m.to].sort().join("\0"), m])).values()]
              .slice(0, 10)
              .map((m) => (
                <Pressable
                  key={[m.from, m.to].sort().join("\0")}
                  accessibilityRole="button"
                  onPress={() => select({ kind: "connection", from: m.from, to: m.to })}
                  className="rounded-lg border border-border p-2"
                >
                  <Text className="text-xs">
                    {participants.get(m.from)?.label} ↔ {participants.get(m.to)?.label}
                  </Text>
                </Pressable>
              ))}
          </View>
        ) : null}
        {sources.map((s) =>
          s.error ? (
            <Text
              key={communicationThreadKey(s.ref)}
              accessibilityRole="alert"
              className="text-sm text-danger-foreground"
            >
              {s.error}
            </Text>
          ) : null,
        )}
        {historyError ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {historyError}
          </Text>
        ) : null}
        <Text className="text-sm font-t3-medium">
          {selected?.label ??
            (selection.kind === "all" ? "All conversations" : "Selected connection")}
        </Text>
        <Text className="text-xs text-foreground-muted">
          Recorded messages. Viewing does not send messages. Select a task to read its own
          conversation. Newest messages first.
        </Text>
        <View className="flex-row flex-wrap gap-1">
          {(
            [
              ["compact", "Collapse all"],
              ["preview", "Short previews"],
              ["full", "Expand all"],
            ] as const
          ).map(([mode, label]) => (
            <Button
              key={mode}
              label={label}
              tone={readingMode === mode ? "secondary" : "text"}
              onPress={() => {
                setReadingMode(mode);
                setReadingRevision((n) => n + 1);
              }}
            />
          ))}
        </View>
        {messages
          .slice(-visibleCount)
          .reverse()
          .map((m) => (
            <View key={m.id} className="gap-1 border-b border-border py-3">
              <Text className="text-xs font-t3-medium">
                {participants.get(m.from)?.label} → {participants.get(m.to)?.label}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {participants.get(m.from)?.environmentLabel} →{" "}
                {participants.get(m.to)?.environmentLabel} · {new Date(m.at).toLocaleString()} ·{" "}
                <Text className={statusClasses[communicationStatusTone(m.state)]}>
                  {m.state === "recorded"
                    ? "In agent thread"
                    : m.state === "pending"
                      ? "Sending"
                      : communicationStatusLabel(m.state)}
                </Text>
              </Text>
              {m.summary ? <Text className="text-sm font-t3-medium">{m.summary}</Text> : null}
              <CommunicationBody
                key={`${m.id}:${readingRevision}`}
                text={m.text}
                initialMode={readingMode}
              />
            </View>
          ))}
        {messages.length > visibleCount ? (
          <Button
            label="Show older messages"
            tone="text"
            onPress={() => setVisibleCount((n) => n + 30)}
          />
        ) : null}
        {messages.length === 0 ? (
          <Text className="py-6 text-sm text-foreground-muted">
            {sources.some((s) => s.thread === null && s.error === null)
              ? "Loading recorded communication…"
              : "No recorded communication in the loaded history. Task prompts and results appear here too."}
          </Text>
        ) : null}
        {history ? (
          <Button
            label={history.history.loading ? "Loading history…" : "Load earlier history"}
            tone="text"
            disabled={history.history.loading}
            onPress={() => {
              setHistoryError(null);
              void loadEarlier({
                environmentId: history.ref.environmentId,
                input: { threadId: history.ref.threadId },
              }).then((result) => {
                if (result._tag !== "Success")
                  setHistoryError("Could not load earlier history. Try again.");
              });
            }}
          />
        ) : null}
        {selected?.threadId ? (
          <Button
            label="Open thread"
            tone="secondary"
            onPress={() =>
              navigation.navigate("Thread", {
                environmentId: selected.environmentId,
                threadId: selected.threadId!,
              })
            }
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

function CommunicationBody({
  text,
  initialMode,
}: {
  text: string;
  initialMode: "compact" | "preview" | "full";
}) {
  const [mode, setMode] = useState(initialMode);
  const styles = useMarkdownPreviewStyles();
  const preview = text.slice(0, 1200).split("\n").slice(0, 12).join("\n");
  const expandable =
    preview.length < text.length || text.length > 400 || text.split("\n").length > 6;
  return (
    <View className="gap-2">
      {mode === "compact" ? (
        <Text numberOfLines={2} className="text-xs text-foreground-muted">
          {text.slice(0, 250).replace(/\s+/g, " ")}
        </Text>
      ) : (
        <View className={mode === "preview" ? "max-h-40 overflow-hidden" : ""}>
          <SelectableMarkdownText
            markdown={mode === "full" ? text : preview}
            textStyle={styles.nativeTextStyle}
            onLinkPress={(href) => {
              if (mode === "full") void tryOpenExternalUrl(href, "markdown-link");
            }}
            renderImage={({ alt }) => (
              <Text className="text-xs text-foreground-muted">{alt || "Image attachment"}</Text>
            )}
          />
        </View>
      )}
      {expandable ? (
        <Button
          label={
            mode === "full"
              ? "Shorten message"
              : mode === "compact"
                ? "Read message"
                : "Show full message"
          }
          tone="text"
          onPress={() => setMode(mode === "full" ? "preview" : "full")}
        />
      ) : null}
    </View>
  );
}

function exchangeCount(count: number) {
  return `${count} ${count === 1 ? "exchange" : "exchanges"}`;
}
