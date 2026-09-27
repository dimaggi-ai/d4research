import { scopedThreadKey, scopeProjectRef } from "@d4research/client-runtime/environment";
import {
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@d4research/client-runtime/state/runtime";
import { DEFAULT_SERVER_SETTINGS, type ScopedThreadRef } from "@d4research/contracts";
import { serializeLegacyContextMessage } from "@d4research/shared/composerContextLegacySend";
import { mergeEnabledSkillNames } from "@d4research/shared/enabledSkillsContext";
import { applyClaudePromptEffortPrefix } from "@d4research/shared/model";

import { buildMessageContext, terminalContextReference } from "../../lib/composerContextRecords";
import { removeInlineContextReference } from "../../lib/composerContextReferences";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  releaseDraftAttachments,
  startAttachmentUpload,
} from "../../lib/attachmentUploadQueue";
import { newMessageId } from "../../lib/utils";
import { getClientSettings, mergeEnvironmentSettings } from "../../hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  latestCompletedToolActivityId,
  useQueuedMessageStore,
  type QueuedComposerMessage,
} from "../../queuedMessageStore";
import { parseInlineDelegateTrigger } from "../../researchPipeline";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readProject, readThread, readThreadShell } from "../../state/entities";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import {
  applyProviderHandoffToMessage,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  deriveLockedProvider,
  readFileAsDataUrl,
  resolveProviderHandoff,
  resolveThreadMetadataUpdateForNextTurn,
  revokeBlobPreviewUrl,
} from "../ChatView.logic";
import { toastManager } from "../ui/toast";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "./composerPromptHistory";

async function run<W, A, E>(command: AtomCommand<W, A, E>, input: W): Promise<A> {
  const result = await runAtomCommand(appAtomRegistry, command, input, { reportFailure: false });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

/**
 * The handoff a queued message needs against its thread's current provider
 * session, built as the composer builds it for a direct send.
 */
function resolveQueuedHandoff(
  threadRef: ScopedThreadRef,
  message: QueuedComposerMessage,
  composedText: string,
): { readonly text: string } | { readonly error: string } | null {
  const thread = readThread(threadRef);
  if (!thread) return null;
  const { environmentId, threadId } = threadRef;
  const providers =
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.providers ?? [];
  const settings = mergeEnvironmentSettings(
    appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId)) ??
      DEFAULT_SERVER_SETTINGS,
    getClientSettings(),
  );
  const resolution = resolveProviderHandoff({
    thread,
    providers,
    entries: sortProviderInstanceEntries(
      applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
    ),
    sessionLockedProvider: deriveLockedProvider({
      thread,
      selectedProvider: message.sendSettings.modelSelection.instanceId,
      threadProvider: thread.modelSelection.instanceId,
      providers,
    }),
    nextModelSelection: message.sendSettings.modelSelection,
  });
  return applyProviderHandoffToMessage({
    resolution,
    composedText,
    thread,
    messages: thread.messages,
    projectTitle: readProject(scopeProjectRef(environmentId, thread.projectId))?.title,
    enabledSkills: mergeEnabledSkillNames(
      settings.skills.enabledByDefault,
      settings.skills.enabledByThread[threadId] ?? [],
    ),
  });
}

/**
 * Sends one queued message as a turn on its thread. `QueuedMessageSender`
 * calls it when the head message is due, and Send now calls it directly. It
 * reads nothing from the composer, so it works for threads that are not on
 * screen. A failed send stays at the head of the queue, held for Send now.
 */
export async function sendQueuedMessage(
  threadRef: ScopedThreadRef,
  messageId: string,
): Promise<void> {
  const { environmentId, threadId } = threadRef;
  const threadKey = scopedThreadKey(threadRef);
  const queue = useQueuedMessageStore.getState();
  const message = queue.beginSend(
    threadKey,
    messageId,
    latestCompletedToolActivityId(readThread(threadRef)?.activities ?? []),
  );
  if (!message) return;
  const { sendSettings } = message;
  const attachments = [...message.images, ...message.files];
  const readConfig = () => appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId);
  const assertFilesAllowed = () => {
    const config = readConfig();
    const reason = fileAttachmentCapabilityBlockReason({
      files: message.files,
      attachmentUploadsCapabilityKnown: config !== undefined,
      supportsAttachmentUploads: config?.environment.capabilities.attachmentUploads === true,
      maxFileAttachmentBytes:
        config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
    });
    if (reason !== null) throw new Error(reason);
  };
  try {
    const { sendableTerminalContexts, hasSendableContent } = deriveComposerSendState({
      prompt: message.prompt,
      imageCount: attachments.length,
      terminalContexts: message.terminalContexts,
      elementContextCount: message.previewAnnotations.length + message.reviewComments.length,
    });
    // Only expired terminal context was left. Retrying would block the queue
    // on every boundary, so drop it and let the queue move on.
    if (!hasSendableContent) {
      queue.finishSend(threadKey, message.id);
      return;
    }
    // Expired terminal excerpts are not sent; their chips leave the text with them.
    const prompt = message.terminalContexts
      .filter((context) => !sendableTerminalContexts.includes(context))
      .reduce(
        (text, context) =>
          removeInlineContextReference(text, terminalContextReference(context).contextId).prompt,
        message.prompt,
      )
      .trim();
    const composedText = applyClaudePromptEffortPrefix(
      prompt || ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      sendSettings.promptEffort,
    );
    // A queued message switches providers exactly as a direct send does: the
    // thread's current state decides whether a handoff is required, and the
    // context is built from the transcript as it is now, not when queued. A
    // delegation is answered by the model it names, so it never hands off and
    // leaves the thread's model alone.
    const isInlineDelegate = parseInlineDelegateTrigger(composedText) !== null;
    const handoff = isInlineDelegate
      ? null
      : resolveQueuedHandoff(threadRef, message, composedText);
    if (handoff !== null && "error" in handoff) throw new Error(handoff.error);
    const text = handoff?.text ?? composedText;

    assertFilesAllowed();
    const useUploads = readConfig()?.environment.capabilities.attachmentUploads === true;
    if (useUploads && attachments.length > 0) {
      for (const attachment of attachments) {
        startAttachmentUpload({ environmentId, image: attachment, draftTarget: threadRef });
      }
      await awaitAttachmentUploads(attachments.map((attachment) => attachment.id));
    }
    const wireAttachments = await Promise.all(
      attachments.map(async (attachment) => {
        if (useUploads) {
          const uploaded = getUploadedAttachments({ environmentId, images: [attachment] })?.[0];
          if (!uploaded) throw new Error(`Attachment '${attachment.name}' did not upload.`);
          return uploaded;
        }
        if (attachment.type !== "image") {
          throw new Error("This server does not support file attachments.");
        }
        return {
          type: "image" as const,
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          dataUrl: await readFileAsDataUrl(attachment.file),
          ...(attachment.source ? { source: attachment.source } : {}),
        };
      }),
    );
    assertFilesAllowed();

    // The server starts the turn with the thread's stored modes, so a change
    // made in the composer before queueing is saved first.
    const createdAt = new Date().toISOString();
    const shell = readThreadShell(threadRef);
    const metadataUpdate = shell
      ? resolveThreadMetadataUpdateForNextTurn({
          currentModelSelection: shell.modelSelection,
          // A handoff's turn start sets the model atomically with its context.
          ...(isInlineDelegate || handoff !== null
            ? {}
            : { nextModelSelection: sendSettings.modelSelection }),
          currentBranch: shell.branch,
        })
      : null;
    if (metadataUpdate) {
      await run(threadEnvironment.updateMetadata, {
        environmentId,
        input: { threadId, ...metadataUpdate },
      });
    }
    if (shell && shell.runtimeMode !== sendSettings.runtimeMode) {
      await run(threadEnvironment.setRuntimeMode, {
        environmentId,
        input: { threadId, runtimeMode: sendSettings.runtimeMode, createdAt },
      });
    }
    if (shell && shell.interactionMode !== sendSettings.interactionMode) {
      await run(threadEnvironment.setInteractionMode, {
        environmentId,
        input: { threadId, interactionMode: sendSettings.interactionMode, createdAt },
      });
    }

    // Stop hands a preparing message back to the composer. Past this point
    // the send can no longer be taken back.
    const thread = readThread(threadRef) ?? undefined;
    if (!queue.markDispatching(threadKey, message.id, createLocalDispatchSnapshot(thread))) return;
    const context = buildMessageContext({
      terminalContexts: sendableTerminalContexts,
      reviewComments: message.reviewComments,
      previewAnnotations: message.previewAnnotations,
      attachments: attachments.map((attachment, index) => ({
        attachment,
        attachmentId: wireAttachments[index]?.id ?? attachment.id,
      })),
    });
    // Servers from before inline context drop the records, so their turns
    // carry the payload in the text instead.
    const inlineContext = readConfig()?.environment.capabilities.inlineMessageContext === true;
    await run(threadEnvironment.startTurn, {
      environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text:
            context !== undefined && !inlineContext
              ? serializeLegacyContextMessage({ text, records: context.records })
              : text,
          attachments: wireAttachments,
          ...(context !== undefined && inlineContext ? { context } : {}),
        },
        // Omitted for a delegation: the thread keeps the model it had.
        ...(isInlineDelegate ? {} : { modelSelection: sendSettings.modelSelection }),
        runtimeMode: sendSettings.runtimeMode,
        interactionMode: sendSettings.interactionMode,
        createdAt,
      },
    });
    queue.finishSend(threadKey, message.id);
    if (useUploads) releaseDraftAttachments(attachments);
    for (const image of message.images) revokeBlobPreviewUrl(image.previewUrl);
  } catch (error) {
    if (!queue.failSend(threadKey, message.id)) return;
    const title = readThreadShell(threadRef)?.title;
    toastManager.add({
      type: "error",
      title: title ? `Queued message not sent in "${title}"` : "Queued message not sent",
      description: error instanceof Error ? error.message : "Use Send now to try again.",
    });
  }
}
