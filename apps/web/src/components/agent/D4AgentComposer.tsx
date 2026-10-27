import {
  D4AgentError,
  DEFAULT_SERVER_SETTINGS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  supportsD4AgentDriver,
  type D4AgentState,
  type EnvironmentId,
  type ModelSelection,
} from "@d4research/contracts";
import {
  agentDraftMovedNotice,
  agentDraftOrigin,
  agentMentionOptions,
  agentMentionQuery,
  insertAgentMention,
  type AgentDraftOrigin,
} from "@d4research/client-runtime/d4-agent-references";
import { squashAtomCommandFailure } from "@d4research/client-runtime/state/runtime";
import { fileAttachmentTooLargeMessage } from "@d4research/client-runtime/state/attachments";
import { createModelSelection } from "@d4research/shared/model";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { PaperclipIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import { useMergedSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { useVoiceConversation } from "../../hooks/useVoiceConversation";
import { prepareImageForAttachment } from "../../lib/imageCompression";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../../lib/attachmentUploadQueue";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { TraitsPicker } from "../chat/TraitsPicker";
import { VoiceConversationBanner, VoiceConversationButton } from "../chat/VoiceConversationControl";
import {
  classifyComposerAttachmentFile,
  fileAttachmentCapabilityBlockReason,
  fileAttachmentStagingLimit,
  normalizeComposerImageFileMimeType,
} from "../chat/composerAttachmentFiles";
import { Button } from "../ui/button";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { ComposerBanner } from "../chat/ComposerBanner";
import { ComposerControl, ComposerControlIcon } from "../chat/ComposerControl";
import { ComposerImageThumbnail } from "../chat/ComposerImageThumbnail";
import { ComposerPrimaryActions } from "../chat/ComposerPrimaryActions";
import { ComposerSurface } from "../chat/ComposerSurface";
import type { ComposerDraftContextRecords } from "../composerContextPresentation";

type DraftAttachment = ComposerImageAttachment | ComposerFileAttachment;
const EMPTY_CONTEXT_RECORDS: ComposerDraftContextRecords = new Map();
const MAX_PROMPT_LENGTH = 16000;
const noop = () => {};
const isD4AgentError = Schema.is(D4AgentError);

export function D4AgentComposer({
  environmentId,
  state,
  active,
  refresh,
  banner,
}: {
  environmentId: EnvironmentId;
  state: D4AgentState;
  active: boolean;
  refresh: () => void;
  banner?: ReactNode;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const allowed = useAtomValue(serverEnvironment.sendD4AgentMessage.permissionAtom(environmentId));
  const canConfigure = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const send = useAtomCommand(serverEnvironment.sendD4AgentMessage);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings);
  const providersByEnvironment = useEnvironmentProviders();
  const projects = useProjects();
  const threads = useThreadShells();
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const focusAfterMention = useRef(false);
  useLayoutEffect(() => {
    if (!focusAfterMention.current) return;
    focusAfterMention.current = false;
    editorRef.current?.focusAtEnd();
  });
  const [origin, setOrigin] = useState<AgentDraftOrigin | null>(null);
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const draftAttachments = useRef(attachments);
  useLayoutEffect(() => {
    draftAttachments.current = attachments;
  }, [attachments]);
  const pending = useRef(0);
  const [preparing, setPreparing] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const uploads = useAttachmentUploadStore((store) => store.uploadsByImageId);
  const enabled = config?.settings.d4Agent.enabled === true;
  const disabled = !enabled || !allowed || sending;
  const moved = agentDraftMovedNotice(origin, state);
  const bindDraft = () => setOrigin((current) => current ?? agentDraftOrigin(state));
  const providers = providersByEnvironment.get(environmentId) ?? EMPTY_SERVER_PROVIDERS;
  const settings = useMergedSettings(config?.settings ?? DEFAULT_SERVER_SETTINGS);
  const selection = settings
    ? (settings.d4Agent.modelSelection ?? resolveAppModelSelectionState(settings, providers))
    : null;
  const entries = settings
    ? sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
      ).filter((entry) => supportsD4AgentDriver(entry.driverKind))
    : [];
  const entry = entries.find((candidate) => candidate.instanceId === selection?.instanceId);
  const modelOptions =
    settings && selection
      ? getCustomModelOptionsByInstance(settings, providers, selection.instanceId, selection.model)
      : new Map();
  const capability = {
    attachmentUploadsCapabilityKnown: config !== null,
    supportsAttachmentUploads: config?.environment.capabilities.attachmentUploads === true,
    maxFileAttachmentBytes:
      config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
  };
  const stagingLimit = fileAttachmentStagingLimit(capability);
  const attachmentBlock = fileAttachmentCapabilityBlockReason({
    ...capability,
    files: attachments.filter((attachment) => attachment.type === "file"),
  });
  const mentions = agentMentionOptions({
    environmentId,
    context: state.brainContext,
    agentProjectId: state.projectId,
    settings,
    projects,
    threads,
    query: agentMentionQuery(text),
  });

  if (!text.trim() && attachments.length === 0 && !preparing && origin !== null) setOrigin(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      releaseDraftAttachments(draftAttachments.current);
      for (const attachment of draftAttachments.current)
        if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
    };
  }, []);

  const saveSelection = async (modelSelection: ModelSelection) => {
    if (!settings || !canConfigure || saving) return;
    setSaving(true);
    try {
      const result = await updateSettings({
        environmentId,
        input: { patch: { d4Agent: { ...settings.d4Agent, modelSelection } } },
      });
      if (result._tag === "Failure") setError("Could not save Nia settings.");
    } catch {
      setError("Could not save Nia settings.");
    } finally {
      setSaving(false);
    }
  };

  const addFiles = async (files: File[]) => {
    if (disabled || files.length === 0) return;
    bindDraft();
    const slots = Math.max(
      0,
      PROVIDER_SEND_TURN_MAX_ATTACHMENTS - draftAttachments.current.length - pending.current,
    );
    const accepted = files.slice(0, slots);
    if (files.length > slots)
      setError(`You can add up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`);
    pending.current += accepted.length;
    setPreparing(pending.current > 0);
    for (const input of accepted) {
      try {
        const kind = classifyComposerAttachmentFile(input);
        if (kind === "unsupported-image")
          throw new Error(
            `'${input.name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`,
          );
        let attachment: DraftAttachment;
        if (kind === "image") {
          const prepared = await prepareImageForAttachment(
            normalizeComposerImageFileMimeType(input),
            PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
          );
          if (!prepared.ok)
            throw new Error(
              prepared.reason === "unreadable"
                ? `'${input.name}' could not be read as an image.`
                : `'${input.name}' is too large to attach, even after compression.`,
            );
          const file = prepared.file;
          attachment = {
            type: "image",
            id: randomUUID(),
            name: file.name || "image",
            mimeType: file.type,
            sizeBytes: file.size,
            file,
            previewUrl: URL.createObjectURL(file),
          };
        } else {
          if (stagingLimit === null)
            throw new Error("This server does not support file attachments.");
          if (input.size <= 0) throw new Error(`'${input.name}' is empty or could not be read.`);
          if (input.size > stagingLimit)
            throw new Error(fileAttachmentTooLargeMessage(input.name, stagingLimit));
          const mimeType = input.type || "application/octet-stream";
          const file =
            input.type === mimeType
              ? input
              : new File([input], input.name, { type: mimeType, lastModified: input.lastModified });
          attachment = {
            type: "file",
            id: randomUUID(),
            name: file.name || "file",
            mimeType,
            sizeBytes: file.size,
            file,
          };
        }
        if (!mounted.current) {
          if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
          continue;
        }
        draftAttachments.current = [...draftAttachments.current, attachment];
        setAttachments(draftAttachments.current);
        startAttachmentUpload({ environmentId, image: attachment });
      } catch (failure) {
        if (mounted.current) setError(failure instanceof Error ? failure.message : "Upload failed");
      } finally {
        pending.current -= 1;
        if (mounted.current) setPreparing(pending.current > 0);
      }
    }
  };

  const submit = async (followUpBehavior: "queue" | "steer" = "queue", voiceText?: string) => {
    const submitted = (voiceText ?? text).slice(0, MAX_PROMPT_LENGTH);
    if (
      sendingRef.current ||
      disabled ||
      pending.current > 0 ||
      moved ||
      attachmentBlock ||
      (!submitted.trim() && attachments.length === 0)
    )
      return;
    const target = origin ?? agentDraftOrigin(state);
    const submittedAttachments = attachments;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      await awaitAttachmentUploads(submittedAttachments.map((attachment) => attachment.id));
      const uploaded = getUploadedAttachments({ environmentId, images: submittedAttachments });
      if (uploaded === null) {
        setError("Could not upload attachments. Your draft is preserved.");
        return;
      }
      const result = await send({
        environmentId,
        input: {
          text: submitted.trim(),
          attachments: uploaded,
          followUpBehavior,
          expectedContext: target.context,
          expectedThreadId: target.threadId,
        },
      });
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        const stale = isD4AgentError(failure) && failure.reason === "stale";
        setError(
          stale
            ? "Not sent: Nia's context or session changed after you wrote this. Your draft is preserved. Check it, then send again."
            : "Could not send this message. Your draft is preserved.",
        );
        if (stale) refresh();
      } else {
        setText((current) => (current === submitted || voiceText !== undefined ? "" : current));
        const ids = new Set(submittedAttachments.map((attachment) => attachment.id));
        draftAttachments.current = draftAttachments.current.filter(
          (attachment) => !ids.has(attachment.id),
        );
        setAttachments(draftAttachments.current);
        releaseDraftAttachments(submittedAttachments);
        for (const attachment of submittedAttachments)
          if (attachment.type === "image") URL.revokeObjectURL(attachment.previewUrl);
        refresh();
      }
    } catch {
      setError("Could not send this message. Your draft is preserved.");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };
  const canSend =
    !disabled &&
    !preparing &&
    !moved &&
    !attachmentBlock &&
    (text.trim().length > 0 || attachments.length > 0);
  return (
    <ComposerSurface.Shell className="[--glass-opacity:100%]">
      <form
        data-chat-composer-form="true"
        className="relative"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {agentMentionQuery(text) !== null && enabled && allowed ? (
          <div
            aria-label="Mention a thread, project, or pipeline"
            className="absolute inset-x-0 bottom-full z-30 mb-2 max-h-48 space-y-1 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 shadow-lg"
          >
            {mentions.map((mention) => (
              <div key={`${mention.kind}:${mention.id}`}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const next = insertAgentMention(text, mention).slice(0, MAX_PROMPT_LENGTH);
                    focusAfterMention.current = true;
                    setText(next);
                    setCursor(next.length);
                    bindDraft();
                  }}
                >
                  {mention.kind} · {mention.title}
                </Button>
              </div>
            ))}
            {mentions.length === 0 ? (
              <p className="text-sm text-muted-foreground">No matching references.</p>
            ) : null}
          </div>
        ) : null}
        {banner ? (
          <ComposerBanner.Attachment>
            <ComposerBanner.Root>{banner}</ComposerBanner.Root>
          </ComposerBanner.Attachment>
        ) : null}
        {preparing ? (
          <ComposerBanner.Attachment>
            <ComposerBanner.Root>
              <ComposerBanner.Row>
                <ComposerBanner.Content role="status">
                  Preparing attachments…
                </ComposerBanner.Content>
              </ComposerBanner.Row>
            </ComposerBanner.Root>
          </ComposerBanner.Attachment>
        ) : null}
        {attachmentBlock ? (
          <ComposerBanner.Attachment>
            <ComposerBanner.Root variant="error">
              <ComposerBanner.Row>
                <ComposerBanner.Content role="status">{attachmentBlock}</ComposerBanner.Content>
              </ComposerBanner.Row>
            </ComposerBanner.Root>
          </ComposerBanner.Attachment>
        ) : null}
        {moved ? (
          <ComposerBanner.Attachment>
            <ComposerBanner.Root variant="warning">
              <ComposerBanner.Row layout="wrap-actions">
                <ComposerBanner.Content role="status">{moved.message}</ComposerBanner.Content>
                <ComposerBanner.Actions>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setOrigin(agentDraftOrigin(state));
                      setError(null);
                    }}
                  >
                    {moved.reassignLabel}
                  </Button>
                </ComposerBanner.Actions>
              </ComposerBanner.Row>
            </ComposerBanner.Root>
          </ComposerBanner.Attachment>
        ) : null}
        {error ? (
          <ComposerBanner.Attachment>
            <ComposerBanner.Root variant="error">
              <ComposerBanner.Row>
                <ComposerBanner.Content role="alert">{error}</ComposerBanner.Content>
              </ComposerBanner.Row>
            </ComposerBanner.Root>
          </ComposerBanner.Attachment>
        ) : null}
        <ComposerSurface.Host>
          <ComposerSurface.Main
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("Files")) event.preventDefault();
            }}
            onDrop={(event) => {
              if (event.dataTransfer.files.length) {
                event.preventDefault();
                void addFiles(Array.from(event.dataTransfer.files));
              }
            }}
          >
            <div className="px-3 pt-3.5 pb-2 sm:px-4 sm:pt-4">
              {attachments.length ? (
                <div aria-label="Attachments" className="mb-3 flex max-w-full flex-wrap gap-2">
                  {attachments.map((attachment) => {
                    const upload = uploads[attachment.id];
                    return (
                      <div
                        key={attachment.id}
                        className={
                          attachment.type === "image"
                            ? "relative h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-border/80 bg-background"
                            : "flex max-w-full items-center gap-2 rounded-lg border border-border/80 bg-background px-2 py-1 text-xs"
                        }
                      >
                        {attachment.type === "image" ? (
                          <ComposerImageThumbnail
                            file={attachment.file}
                            alt={attachment.name}
                            className="h-full w-full object-cover"
                            fallback={
                              <div className="flex h-full items-center justify-center">
                                <PaperclipIcon className="size-4" />
                              </div>
                            }
                          />
                        ) : (
                          <PaperclipIcon className="size-4 shrink-0" />
                        )}
                        {attachment.type === "file" ? (
                          <span className="truncate">{attachment.name}</span>
                        ) : null}
                        {upload?.status === "uploading" ? (
                          <span
                            role="status"
                            className={
                              attachment.type === "image"
                                ? "absolute inset-x-0 bottom-0 bg-background/85 px-1 text-center text-3xs"
                                : undefined
                            }
                          >
                            {Math.round(upload.progress * 100)}%
                          </span>
                        ) : null}
                        {upload?.status === "failed" ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="overlay"
                            className={
                              attachment.type === "image" ? "absolute bottom-0 left-0" : undefined
                            }
                            disabled={disabled}
                            onClick={() =>
                              retryAttachmentUpload({ environmentId, image: attachment })
                            }
                          >
                            Retry
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="icon-xs"
                          variant={attachment.type === "image" ? "media-close" : "ghost"}
                          className={
                            attachment.type === "image" ? "absolute right-1 top-1" : undefined
                          }
                          aria-label={`Remove ${attachment.name}`}
                          disabled={sending}
                          onClick={() => {
                            draftAttachments.current = draftAttachments.current.filter(
                              (item) => item.id !== attachment.id,
                            );
                            setAttachments(draftAttachments.current);
                            releaseDraftAttachments([attachment]);
                            if (attachment.type === "image")
                              URL.revokeObjectURL(attachment.previewUrl);
                          }}
                        >
                          <XIcon />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              <ComposerPromptEditor
                value={text}
                cursor={cursor}
                literalText
                maxLength={MAX_PROMPT_LENGTH}
                contextRecords={EMPTY_CONTEXT_RECORDS}
                skills={[]}
                editorRef={editorRef}
                ariaLabel="Message Nia"
                placeholder="Message Nia"
                disabled={disabled}
                onChange={(value, nextCursor) => {
                  setText(value.slice(0, MAX_PROMPT_LENGTH));
                  setCursor(Math.min(nextCursor, MAX_PROMPT_LENGTH));
                  if (value.trim()) bindDraft();
                }}
                onCommandKeyDown={(key, event) => {
                  if (key !== "Enter" || event.shiftKey || event.isComposing) return false;
                  void submit(active && (event.metaKey || event.ctrlKey) ? "steer" : "queue");
                  return true;
                }}
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.files);
                  if (files.length) {
                    event.preventDefault();
                    void addFiles(files);
                  }
                }}
              />
            </div>
            <div
              data-chat-composer-footer="true"
              className="flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4"
            >
              <div
                data-chat-composer-controls="left"
                className="relative -m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {selection ? (
                  <ProviderModelPicker
                    environmentId={environmentId}
                    activeInstanceId={selection.instanceId}
                    model={selection.model}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={modelOptions}
                    triggerAriaLabel="Nia model"
                    disabled={!canConfigure || saving || sending}
                    onInstanceModelChange={(instanceId, model) =>
                      void saveSelection(createModelSelection(instanceId, model))
                    }
                  />
                ) : null}
                {selection && entry ? (
                  <TraitsPicker
                    provider={entry.driverKind}
                    instanceId={selection.instanceId}
                    models={entry.models}
                    model={selection.model}
                    prompt={text}
                    onPromptChange={(value) => {
                      setText(value.slice(0, MAX_PROMPT_LENGTH));
                      setCursor(Math.min(value.length, MAX_PROMPT_LENGTH));
                      bindDraft();
                    }}
                    modelOptions={selection.options}
                    onModelOptionsChange={(options) =>
                      void saveSelection(
                        createModelSelection(selection.instanceId, selection.model, options),
                      )
                    }
                    allowPromptInjectedEffort={false}
                    planModeEnabled={false}
                    disabled={!canConfigure || saving || sending}
                  />
                ) : null}
              </div>
              <div
                data-chat-composer-actions="right"
                className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
              >
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  aria-label="Attach files input"
                  onChange={(event) => {
                    void addFiles(Array.from(event.target.files ?? []));
                    event.target.value = "";
                  }}
                />

                <ComposerControl
                  aria-label="Attach files"
                  disabled={disabled || preparing || !capability.supportsAttachmentUploads}
                  onClick={() => fileInput.current?.click()}
                >
                  <ComposerControlIcon icon={PaperclipIcon} />
                </ComposerControl>
                <NiaVoice
                  key={`${environmentId}:${state.brainContext}:${state.threadId}`}
                  state={state}
                  error={error}
                  disabled={
                    disabled ||
                    preparing ||
                    moved !== null ||
                    attachments.length > 0 ||
                    text.trim().length > 0
                  }
                  onTranscript={(transcript) => {
                    if (disabled || preparing || moved || attachments.length || text.trim())
                      return false;
                    setText(transcript.slice(0, MAX_PROMPT_LENGTH));
                    setCursor(Math.min(transcript.length, MAX_PROMPT_LENGTH));
                    bindDraft();
                    void submit("queue", transcript);
                    return true;
                  }}
                  onError={setError}
                />

                <ComposerPrimaryActions
                  compact={false}
                  canOperateThread={enabled && allowed}
                  pendingAction={null}
                  isRunning={active}
                  canInterrupt={false}
                  followUpBehavior="queue"
                  showPlanFollowUpPrompt={false}
                  promptHasText={text.trim().length > 0}
                  isSendBusy={sending}
                  sendDisabledReason={
                    attachmentBlock ??
                    moved?.message ??
                    (preparing ? "Preparing attachments…" : null)
                  }
                  isConnecting={false}
                  isEnvironmentUnavailable={false}
                  isPreparingWorktree={false}
                  hasSendableContent={canSend}
                  onSubmitMessage={(event) => {
                    event.preventDefault();
                    void submit(active && (event.metaKey || event.ctrlKey) ? "steer" : "queue");
                  }}
                  onPreviousPendingQuestion={noop}
                  onInterrupt={noop}
                  onImplementPlanInNewThread={noop}
                />
              </div>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </form>
    </ComposerSurface.Shell>
  );
}

function NiaVoice({
  state,
  disabled,
  error,
  onTranscript,
  onError,
}: {
  state: D4AgentState;
  disabled: boolean;
  error: string | null;
  onTranscript: (text: string) => boolean;
  onError: (message: string) => void;
}) {
  const voice = useVoiceConversation({
    messages: (state.transcript ?? [])
      .filter((entry) => entry.role !== "system")
      .map((entry) => ({
        id: entry.id,
        role: entry.role === "assistant" ? ("assistant" as const) : ("user" as const),
        text: entry.text,
        streaming: false,
      })),
    onTranscript,
    onError,
  });
  const stop = useRef(voice.stopConversation);
  useLayoutEffect(() => {
    stop.current = voice.stopConversation;
  });
  useEffect(() => {
    if (error) stop.current();
  }, [error]);
  return (
    <>
      <VoiceConversationButton
        {...voice}
        disabled={disabled && !voice.active}
        onToggle={voice.toggleConversation}
      />
      <div className="absolute inset-x-0 bottom-full">
        <VoiceConversationBanner {...voice} onToggle={voice.toggleConversation} />
      </div>
    </>
  );
}
