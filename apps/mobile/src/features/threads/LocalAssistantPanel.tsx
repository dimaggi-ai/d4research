import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, Modal, Platform, Pressable, ScrollView, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { EnvironmentId, ThreadId } from "@d4research/contracts";
import {
  localAssistantTasks,
  runLocalAssistant,
  selectLocalExcerpts,
  type LocalAssistantTask,
} from "@d4research/client-runtime/local-assistant";
import { AppText as Text } from "../../components/ui/AppText";
import { appleGenerate, appleModelAvailable } from "../local-development/models";
import { useThreadProjection } from "../../state/use-thread-detail";

function Action(props: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-11 justify-center rounded-lg bg-subtle-strong px-3 py-2"
      style={{ opacity: props.disabled ? 0.5 : 1 }}
    >
      <Text className="text-sm text-foreground">{props.label}</Text>
    </Pressable>
  );
}
export function LocalAssistantPanel(props: {
  disabled?: boolean;
  draft: string;
  onChange: (value: string) => void;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
}) {
  const [selection, setSelection] = useState<"clean" | "shorten" | "tools" | null>(null);
  if (Platform.OS !== "ios") return null;
  return (
    <>
      <View className="flex-row flex-wrap gap-2">
        {props.draft.trim() ? (
          <>
            <Action
              disabled={props.disabled}
              label="Fix typos"
              onPress={() => setSelection("clean")}
            />
            <Action
              disabled={props.disabled}
              label="Shorten"
              onPress={() => setSelection("shorten")}
            />
          </>
        ) : null}
        <Action
          disabled={props.disabled}
          label="More text tools"
          onPress={() => setSelection("tools")}
        />
      </View>
      {selection ? (
        <Assistant {...props} initialTask={selection} close={() => setSelection(null)} />
      ) : null}
    </>
  );
}
function Assistant(props: {
  draft: string;
  onChange: (value: string) => void;
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  initialTask: "clean" | "shorten" | "tools";
  close: () => void;
}) {
  const thread = useThreadProjection(props);
  const [showTools, setShowTools] = useState(props.initialTask === "tools");
  const started = useRef(false);
  const [source, setSource] = useState(props.draft);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [task, setTask] = useState<LocalAssistantTask | "context">("clean");
  const [query, setQuery] = useState("");
  const [baseline, setBaseline] = useState(props.draft);
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    let mounted = true;
    const background = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        abort.current?.abort();
        setBusy(false);
      }
    });
    void appleModelAvailable()
      .then((value) => {
        if (mounted) setAvailable(value);
      })
      .catch(() => {
        if (mounted) setAvailable(false);
      });
    return () => {
      background.remove();
      mounted = false;
      abort.current?.abort();
    };
  }, []);
  const close = () => {
    abort.current?.abort();
    props.close();
  };
  const run = useCallback(
    async (next: LocalAssistantTask) => {
      if (busy) return;
      const controller = new AbortController();
      abort.current = controller;
      setBusy(true);
      setResult("");
      setError("");
      setTask(next);
      setBaseline(props.draft);
      try {
        const output = await runLocalAssistant(
          next,
          source,
          (instructions, input, signal) =>
            appleGenerate(
              [
                { role: "system", content: instructions },
                { role: "user", content: input },
              ],
              signal,
            ),
          controller.signal,
        );
        if (!controller.signal.aborted) setResult(output);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "Local generation failed.");
      } finally {
        if (abort.current === controller) setBusy(false);
      }
    },
    [busy, source, props.draft],
  );
  useEffect(() => {
    if (available && props.initialTask !== "tools" && !started.current) {
      started.current = true;
      void run(props.initialTask);
    }
  }, [available, props.initialTask, run]);
  const apply = () => {
    if (props.draft !== baseline) {
      setError("Your draft changed. Copy the result or run the action again.");
      return;
    }
    const after =
      task === "clean" || task === "shorten" || task === "context"
        ? result
        : [props.draft, result].filter(Boolean).join("\n\n");
    setUndo({ before: props.draft, after });
    props.onChange(after);
    setBaseline(after);
    setResult("");
  };
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: 24, gap: 14 }}
        className="bg-background"
      >
        <View className="flex-row items-center justify-between">
          <Text className="text-lg text-foreground">
            {showTools
              ? "Text tools"
              : localAssistantTasks[props.initialTask === "shorten" ? "shorten" : "clean"]}
          </Text>
          <Action label="Close" onPress={close} />
        </View>
        <Text className="text-sm text-foreground-muted">
          Uses Apple Intelligence on this device. Review changes before applying.
        </Text>
        {available === false ? (
          <Text className="text-sm text-foreground-muted">
            Apple Intelligence is unavailable. Enable it on a supported device. Excerpt selection
            still works locally.
          </Text>
        ) : null}
        {showTools ? (
          <>
            <View className="flex-row flex-wrap gap-2">
              <Action
                label="Use draft"
                disabled={busy}
                onPress={() => {
                  setSource(props.draft);
                  setResult("");
                }}
              />
              <Action
                label="Use loaded chat"
                disabled={busy || !thread}
                onPress={() => {
                  setSource(
                    thread?.projection.messages
                      .map((message) => `${message.role}: ${message.text}`)
                      .join("\n\n") ?? "",
                  );
                  setResult("");
                }}
              />
            </View>
            <Text className="text-xs text-foreground-muted">
              Loaded chat includes only messages currently cached here. You can also paste a
              document or log excerpt below.
            </Text>
            <Action
              label="Open text file"
              disabled={busy}
              onPress={() => {
                void (async () => {
                  try {
                    const picked = await DocumentPicker.getDocumentAsync({
                      type: ["text/*", "application/json"],
                      copyToCacheDirectory: true,
                    });
                    if (picked.canceled) return;
                    const asset = picked.assets[0];
                    if (!asset) return;
                    const file = new File(asset.uri);
                    try {
                      if (file.size > 48_000) throw new Error("Choose a text file up to 48 KB.");
                      setSource(await file.text());
                      setResult("");
                      setError("");
                    } finally {
                      file.delete();
                    }
                  } catch (cause) {
                    setError(
                      cause instanceof Error ? cause.message : "Could not read the text file.",
                    );
                  }
                })();
              }}
            />
            <TextInput
              accessibilityLabel="Source text"
              multiline
              editable={!busy}
              value={source}
              onChangeText={(value) => {
                setSource(value);
                setResult("");
              }}
              className="min-h-40 rounded-lg border border-border p-3 text-foreground"
            />
            <View className="flex-row flex-wrap gap-2">
              {Object.entries(localAssistantTasks).map(([key, label]) => (
                <Action
                  key={key}
                  label={label}
                  disabled={busy || available !== true || !source.trim()}
                  onPress={() => void run(key as LocalAssistantTask)}
                />
              ))}
            </View>
            <TextInput
              accessibilityLabel="Find relevant context"
              placeholder="What context do you need?"
              value={query}
              onChangeText={setQuery}
              editable={!busy}
              className="rounded-lg border border-border p-3 text-foreground"
            />
            <Action
              label="Find excerpts locally"
              disabled={busy || !query.trim()}
              onPress={() => {
                setTask("context");
                setBaseline(props.draft);
                setError("");
                const excerpts = selectLocalExcerpts(query, [
                  { label: "Selected source", text: source },
                ]);
                setResult(excerpts.map((item) => `[${item.label}]\n${item.text}`).join("\n\n"));
                if (!excerpts.length)
                  setError(
                    "No matching excerpts fit. Try a more specific query or a smaller source.",
                  );
              }}
            />
          </>
        ) : null}
        {busy ? (
          <Action
            label="Cancel generation"
            onPress={() => {
              abort.current?.abort();
              setBusy(false);
            }}
          />
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" className="text-sm text-foreground">
            {error}
          </Text>
        ) : null}
        {result ? (
          <>
            <Text className="text-sm text-foreground-muted">
              Preview · {source.length} → {result.length} characters. Character counts are not
              billed tokens.
            </Text>
            <Text selectable className="text-sm text-foreground">
              {result}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              <Action
                label={
                  task === "clean" || task === "shorten" || task === "context"
                    ? "Replace draft"
                    : "Add to draft"
                }
                onPress={apply}
              />
              <Action label="Copy" onPress={() => void Clipboard.setStringAsync(result)} />
              <Action label="Discard" onPress={() => setResult("")} />
            </View>
          </>
        ) : null}
        {!showTools ? <Action label="More text tools" onPress={() => setShowTools(true)} /> : null}
        {undo ? (
          <Action
            label="Undo draft change"
            disabled={props.draft !== undo.after}
            onPress={() => {
              props.onChange(undo.before);
              setBaseline(undo.before);
              setUndo(null);
            }}
          />
        ) : null}
      </ScrollView>
    </Modal>
  );
}
