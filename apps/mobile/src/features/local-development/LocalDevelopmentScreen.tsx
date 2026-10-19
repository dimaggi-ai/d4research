import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Platform,
  Pressable,
  TextInput,
  View,
} from "react-native";
import { File, Directory, Paths } from "expo-file-system";
import * as DocumentPicker from "expo-document-picker";
import * as Sharing from "expo-sharing";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import { WebView } from "react-native-webview";
import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsChoiceRow } from "../settings/components/SettingsChoiceRow";
import { appleModelAvailable, generateLocalTask } from "./models";
import {
  loadLocalApiKey,
  loadLocalWorkspace,
  saveLocalApiKey,
  saveLocalWorkspace,
} from "./storage";
import { javascriptTestDocument } from "./javascriptTest";
import {
  applyProposal,
  cloudEndpoint,
  decodeProposal,
  emptyWorkspace,
  putFile,
  type LocalWorkspace,
  type ProposedChanges,
} from "./workspace";

const MODE_OPTIONS = [
  {
    mode: "apple",
    label: "Apple Intelligence",
    description: "Runs on this device. Requires Apple Intelligence and iOS 26 or later.",
  },
  {
    mode: "gguf",
    label: "Imported GGUF model",
    description:
      "Runs a compatible model on this device. Bonsai 2 needs a custom runtime and is not supported in this build.",
  },
  {
    mode: "cloud",
    label: "Cloud API — optional",
    description: "Sends your task, conversation, and selected file to the HTTPS API you configure.",
  },
] as const;

function formatScratchTestResult(result: { ok?: boolean; logs?: unknown; error?: string }): string {
  return [
    result.ok ? "Scratch test passed." : "Scratch test failed.",
    ...(Array.isArray(result.logs) ? result.logs : []),
    result.error ?? "",
  ].join("\n");
}

export function LocalDevelopmentScreen() {
  const [workspace, setWorkspace] = useState(emptyWorkspace);
  const current = useRef(workspace);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState("");
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [prompt, setPrompt] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [savedApiKey, setSavedApiKey] = useState("");
  const [proposal, setProposal] = useState<{
    changes: ProposedChanges;
    base: Record<string, string>;
  } | null>(null);
  const [testDocument, setTestDocument] = useState<string | null>(null);
  const [testResult, setTestResult] = useState("");
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const operation = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const check = () => {
      void appleModelAvailable().then((value) => {
        if (mounted.current) setAvailable(value);
      });
    };
    check();
    void loadLocalWorkspace()
      .then(async (value) => {
        const key = await loadLocalApiKey(value.endpoint);
        if (!mounted.current) return;
        current.current = value;
        setWorkspace(value);
        setProposal(value.pending ?? null);
        setEndpoint(value.endpoint);
        setModel(value.model);
        setApiKey(key ?? "");
        setSavedApiKey(key ?? "");
        setReady(true);
      })
      .catch(() => {
        if (mounted.current)
          setError("The saved workspace could not be loaded. Close this screen and try again.");
      });
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") check();
      else controller.current?.abort();
    });
    return () => {
      mounted.current = false;
      controller.current?.abort();
      listener.remove();
    };
  }, []);

  async function persist(next: LocalWorkspace) {
    await saveLocalWorkspace(next, current.current);
    current.current = next;
    if (mounted.current) {
      setWorkspace(next);
      setProposal(next.pending ?? null);
    }
  }
  async function perform(action: () => Promise<void>) {
    if (operation.current || !ready) return;
    operation.current = true;
    setBusy(true);
    setError("");
    const completeOperation = async () => {
      try {
        await action();
      } catch (cause) {
        if (mounted.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "The operation failed. Your saved files remain on this device.",
          );
      }
    };
    return await completeOperation().finally(() => {
      operation.current = false;
      if (mounted.current) setBusy(false);
    });
  }
  const dirty = content !== (workspace.files[path] ?? "");
  async function send() {
    if (dirty) throw new Error("Save the file before asking the model to change it.");
    if (
      workspace.mode === "cloud" &&
      (endpoint !== workspace.endpoint || model !== workspace.model || apiKey !== savedApiKey)
    )
      throw new Error("Save the API settings before sending a task.");
    const snapshot = current.current;
    const task = prompt;
    const abort = new AbortController();
    controller.current = abort;
    setGenerating(true);
    const timer = setTimeout(() => abort.abort(), 180_000);
    setProposal(null);
    const completeOperation = async () => {
      const text = await generateLocalTask(snapshot, path, task, apiKey, abort.signal);
      if (abort.signal.aborted || !mounted.current) return;
      const changes = decodeProposal(text);
      const identity =
        snapshot.mode === "apple"
          ? "Apple Intelligence"
          : snapshot.mode === "gguf"
            ? (snapshot.modelUri.split("/").pop() ?? "GGUF")
            : `Cloud: ${snapshot.model}`;
      const pending = {
        changes,
        base: Object.fromEntries(
          changes.edits
            .filter((edit) => Object.hasOwn(snapshot.files, edit.path))
            .map((edit) => [edit.path, snapshot.files[edit.path]!]),
        ),
      };
      await persist({
        ...snapshot,
        pending,
        messages: [
          ...snapshot.messages,
          { id: Crypto.randomUUID(), role: "user", content: task, model: identity },
          { id: Crypto.randomUUID(), role: "assistant", content: text, model: identity },
        ],
      });
      if (mounted.current) {
        setProposal(pending);
        setPrompt("");
      }
    };
    return await completeOperation().finally(() => {
      clearTimeout(timer);
      controller.current = null;
      if (mounted.current) setGenerating(false);
    });
  }
  async function importFile() {
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (picked.canceled) return;
    const asset = picked.assets[0]!;
    const file = new File(asset.uri);
    if (file.size > 400_000) throw new Error("Choose a text file smaller than 400 KB.");
    const text = await file.text();
    await persist({ ...current.current, files: putFile(current.current.files, asset.name, text) });
    setPath(asset.name);
    setContent(text);
  }
  async function importModel() {
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: false });
    if (picked.canceled) return;
    const asset = picked.assets[0]!;
    if (!asset.name.toLowerCase().endsWith(".gguf")) throw new Error("Choose a GGUF model file.");
    if (/bonsai/i.test(asset.name))
      throw new Error(
        "Bonsai 2 requires PrismML's custom runtime. This build supports standard GGUF models and Apple Intelligence.",
      );
    const file = new File(asset.uri);
    const memoryLimit = Math.min(2_000_000_000, (Device.totalMemory ?? 4_000_000_000) * 0.4);
    if (file.size <= 0 || file.size > memoryLimit)
      throw new Error(
        "Choose a smaller model. This file exceeds the import memory limit for this device.",
      );
    const directory = new Directory(Paths.document, "local-development-models");
    directory.create({ idempotent: true, intermediates: true });
    const destination = new File(directory, `${Crypto.randomUUID()}-${asset.name}`);
    file.copy(destination);
    const previous = current.current.modelUri;
    try {
      await persist({ ...current.current, modelUri: destination.uri });
    } catch (cause) {
      destination.delete();
      throw cause;
    }
    if (previous && previous.startsWith(directory.uri) && previous !== destination.uri) {
      const old = new File(previous);
      if (old.exists) old.delete();
    }
  }
  async function exportWorkspace() {
    const directory = new Directory(Paths.cache, "local-development-exports");
    directory.create({ idempotent: true, intermediates: true });
    const file = new File(directory, "workspace.json");
    file.create({ overwrite: true });
    file.write(JSON.stringify(current.current, null, 2));
    await Sharing.shareAsync(file.uri, {
      mimeType: "application/json",
      dialogTitle: "Export workspace",
    });
  }
  function selectFile(selected: string) {
    setPath(selected);
    setContent(workspace.files[selected] ?? "");
    setTestResult("");
  }
  if (Platform.OS !== "ios") return null;
  return (
    <SettingsScreen title="Local development">
      <ScreenScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 p-5 pb-12"
      >
        <Text className="text-sm text-foreground-muted">
          Files and conversations are saved on this device. No d4 server is required. Shell
          commands, package installation, and native builds require a development machine.
        </Text>
        {error ? (
          <Text accessibilityRole="alert" className="text-danger-foreground">
            {error}
          </Text>
        ) : null}
        {!ready && !error ? <ActivityIndicator /> : null}
        <SettingsSection title="Model">
          {MODE_OPTIONS.map((option, index) => (
            <SettingsChoiceRow
              key={option.mode}
              label={option.label}
              description={option.description}
              selected={workspace.mode === option.mode}
              separated={index > 0}
              disabled={!ready || busy}
              onPress={() => {
                void perform(() => persist({ ...current.current, mode: option.mode }));
              }}
            />
          ))}
        </SettingsSection>
        {workspace.mode === "apple" && !available ? (
          <Text className="text-sm text-foreground-muted">
            Apple Intelligence is not available on this device right now.
          </Text>
        ) : null}
        {workspace.mode === "gguf" ? (
          <SettingsSection title="Model file">
            <Text className="p-4 text-sm text-foreground-muted">
              {workspace.modelUri
                ? "A model file is saved on this device."
                : "Import a small, compatible GGUF model from Files."}
            </Text>
            <SettingsActionRow
              icon="arrow.down"
              label="Import GGUF model"
              disabled={!ready || busy}
              onPress={() => {
                void perform(importModel);
              }}
            />
            <SettingsActionRow
              icon="trash"
              label="Remove model"
              disabled={!workspace.modelUri || busy}
              onPress={() => {
                void perform(async () => {
                  const uri = current.current.modelUri;
                  await persist({ ...current.current, modelUri: "" });
                  const file = new File(uri);
                  if (file.exists) file.delete();
                });
              }}
            />
          </SettingsSection>
        ) : null}
        {workspace.mode === "cloud" ? (
          <View className="gap-3">
            <Field
              label="HTTPS API base URL"
              value={endpoint}
              onChange={(value) => {
                setEndpoint(value);
                setApiKey("");
              }}
              editable={!busy}
              placeholder="https://your-provider.example/v1"
            />
            <Field label="Model name" value={model} onChange={setModel} editable={!busy} />
            <Field
              label="API key (optional)"
              value={apiKey}
              onChange={setApiKey}
              editable={!busy}
              secret
            />
            <Text className="text-sm text-foreground-muted">
              Uses the OpenAI-compatible chat API. Keys are kept in this device's Keychain. Changing
              the endpoint clears the key field.
            </Text>
            <SettingsSection>
              <SettingsActionRow
                icon="checkmark"
                label="Save API settings"
                disabled={!ready || busy}
                onPress={() => {
                  void perform(async () => {
                    cloudEndpoint(endpoint);
                    await saveLocalApiKey(endpoint, apiKey);
                    await persist({ ...current.current, endpoint, model });
                    setSavedApiKey(apiKey);
                  });
                }}
              />
            </SettingsSection>
          </View>
        ) : null}
        <SettingsSection title="Files">
          {Object.keys(workspace.files).map((filePath) => (
            <Pressable
              key={filePath}
              disabled={busy}
              onPress={() => {
                if (dirty) {
                  setError("Save or discard your file edits before selecting another file.");
                  return;
                }
                selectFile(filePath);
              }}
              className="p-3"
            >
              <Text className={filePath === path ? "text-accent-foreground" : "text-foreground"}>
                {filePath}
              </Text>
            </Pressable>
          ))}
          <SettingsActionRow
            icon="arrow.down"
            label="Import text file"
            disabled={!ready || busy || dirty}
            onPress={() => {
              void perform(importFile);
            }}
          />
          <SettingsActionRow
            icon="plus"
            label="New file"
            disabled={!ready || busy || dirty}
            onPress={() => {
              setPath("");
              setContent("");
            }}
          />
        </SettingsSection>
        <Field
          label="File path"
          value={path}
          onChange={setPath}
          editable={!busy}
          placeholder="src/example.js"
        />
        <Field
          label="File contents"
          value={content}
          onChange={setContent}
          editable={!busy}
          multiline
        />
        <SettingsSection>
          <SettingsActionRow
            icon="checkmark"
            label="Save file"
            disabled={!ready || busy || !path}
            onPress={() => {
              void perform(async () => {
                await persist({
                  ...current.current,
                  files: putFile(current.current.files, path, content),
                });
              });
            }}
          />
          <SettingsActionRow
            icon="arrow.uturn.backward"
            label="Discard file edits"
            disabled={!ready || busy}
            onPress={() => setContent(workspace.files[path] ?? "")}
          />
          <SettingsActionRow
            icon="trash"
            label="Delete file"
            disabled={!ready || busy || !Object.hasOwn(workspace.files, path)}
            onPress={() =>
              Alert.alert("Delete file?", path, [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Delete",
                  style: "destructive",
                  onPress: () => {
                    void perform(async () => {
                      const files = { ...current.current.files };
                      delete files[path];
                      await persist({ ...current.current, files });
                      setPath("");
                      setContent("");
                    });
                  },
                },
              ])
            }
          />
          <SettingsActionRow
            icon="play"
            label="Run JavaScript scratch test"
            disabled={!ready || busy || testDocument !== null || !path.endsWith(".js")}
            onPress={() => {
              setTestResult("");
              setTestDocument(javascriptTestDocument(content));
            }}
          />
        </SettingsSection>
        <Text className="text-sm text-foreground-muted">
          Scratch tests run the editor's JavaScript with console.log and assert(condition, message).
          Imports, dependencies, and network access are unavailable.
        </Text>
        {testResult ? (
          <Text selectable className="text-sm text-foreground">
            {testResult}
          </Text>
        ) : null}
        {testDocument ? (
          <View style={{ height: 1 }}>
            <WebView
              source={{ html: testDocument }}
              javaScriptEnabled
              originWhitelist={["about:blank"]}
              onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
              onMessage={(event) => {
                try {
                  const result = JSON.parse(event.nativeEvent.data);
                  setTestResult(formatScratchTestResult(result));
                } catch {
                  setTestResult("The scratch test returned an invalid result.");
                }
                setTestDocument(null);
              }}
              onError={() => {
                setTestResult("JavaScript test could not start.");
                setTestDocument(null);
              }}
            />
          </View>
        ) : null}
        <SettingsSection title="Conversation">
          {workspace.messages.map((message) => (
            <View key={message.id ?? `${message.role}-${message.content}`} className="gap-1 p-4">
              <Text className="text-sm text-foreground-muted">
                {message.role === "user" ? "You" : message.model}
              </Text>
              <Text selectable className="text-foreground">
                {message.content}
              </Text>
            </View>
          ))}
        </SettingsSection>
        <Field
          label="Development task"
          value={prompt}
          onChange={setPrompt}
          editable={!busy}
          multiline
        />
        <SettingsSection>
          <SettingsActionRow
            icon="arrow.up"
            label={workspace.mode === "cloud" ? "Send to cloud API" : "Ask on-device model"}
            disabled={!ready || busy || !prompt.trim()}
            loading={generating}
            onPress={() => {
              void perform(send);
            }}
          />
          {generating ? (
            <SettingsActionRow
              icon="stop.fill"
              label="Stop generation"
              onPress={() => controller.current?.abort()}
            />
          ) : null}
        </SettingsSection>
        {proposal ? (
          <SettingsSection title="Proposed file changes">
            <Text className="p-4 text-foreground">{proposal.changes.reply}</Text>
            {proposal.changes.edits.map((edit) => (
              <View key={edit.path} className="gap-2 p-4">
                <Text className="text-sm text-foreground-muted">{edit.path}</Text>
                <Text selectable className="text-foreground">
                  {edit.content}
                </Text>
              </View>
            ))}
            <SettingsActionRow
              icon="checkmark"
              label="Apply proposed changes"
              disabled={busy || dirty || proposal.changes.edits.length === 0}
              onPress={() => {
                void perform(async () => {
                  const next = applyProposal(
                    current.current,
                    proposal.base,
                    proposal.changes.edits,
                  );
                  await persist({
                    ...next,
                    pending: undefined,
                    messages: [
                      ...next.messages,
                      {
                        id: Crypto.randomUUID(),
                        role: "user",
                        content: "Applied proposed file changes.",
                        model: "Workspace",
                      },
                    ],
                  });
                  setContent(next.files[path] ?? "");
                  setProposal(null);
                });
              }}
            />
            <SettingsActionRow
              icon="xmark"
              label="Discard proposal"
              disabled={busy}
              onPress={() => {
                void perform(async () => {
                  await persist({
                    ...current.current,
                    pending: undefined,
                    messages: [
                      ...current.current.messages,
                      {
                        id: Crypto.randomUUID(),
                        role: "user",
                        content: "Discarded proposed file changes.",
                        model: "Workspace",
                      },
                    ],
                  });
                });
              }}
            />
          </SettingsSection>
        ) : null}
        <SettingsSection>
          <SettingsActionRow
            icon="tray.and.arrow.up"
            label="Export workspace"
            disabled={!ready || busy}
            onPress={() => {
              void perform(exportWorkspace);
            }}
          />
          <SettingsActionRow
            icon="arrow.clockwise"
            label="New conversation"
            disabled={!ready || busy}
            onPress={() =>
              Alert.alert(
                "Start a new conversation?",
                "The current conversation will be cleared. Export it first to keep a copy. Files stay in this workspace.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Clear conversation",
                    style: "destructive",
                    onPress: () => {
                      void perform(async () => {
                        await persist({ ...current.current, messages: [], pending: undefined });
                        setProposal(null);
                      });
                    },
                  },
                ],
              )
            }
          />
        </SettingsSection>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
function Field(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  editable: boolean;
  placeholder?: string;
  multiline?: boolean;
  secret?: boolean;
}) {
  return (
    <View className="gap-2">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChange}
        editable={props.editable}
        placeholder={props.placeholder}
        secureTextEntry={props.secret}
        multiline={props.multiline}
        autoCapitalize="none"
        autoCorrect={false}
        className="rounded-lg border border-border bg-surface p-3 text-foreground"
        style={props.multiline ? { minHeight: 140, textAlignVertical: "top" } : undefined}
      />
    </View>
  );
}
