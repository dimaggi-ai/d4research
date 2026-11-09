import * as Dialog from "../../components/ui/Dialog";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@d4research/contracts";
import {
  clampFileAttachmentUploadBytes,
  formatAttachmentSize,
} from "@d4research/client-runtime/state/attachments";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";

import { AppBar, type AppBarMenu } from "../../components/ui/AppBar";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useRefreshAssetUrl } from "../../state/assets";
import { scopedThreadKey } from "../../lib/scopedEntities";
import {
  AttachmentDocumentBody,
  nativeViewerKind,
  isZipFile,
  ZipArchiveView,
} from "./ZipArchiveView";
import { FilePreviewModal, type FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { useAttachmentDocument } from "../../lib/attachmentDocument";
import { nativeViewerErrorMessage } from "../../lib/attachmentDownload";
import { isFileBackedComposerAttachment } from "../../lib/composerImages";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { removeComposerDraftAttachment, useComposerDraft } from "../../state/use-composer-drafts";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

export type AttachmentFileRouteParams = {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly attachmentId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: string;
  readonly draftKey?: string;
  readonly htmlRender?: "1";
};

type AttachmentFileScreenProps = StaticScreenProps<AttachmentFileRouteParams>;

export function AttachmentFileScreen(props: AttachmentFileScreenProps) {
  const navigation = useNavigation();
  const { appearance, setCodeWordBreak } = useAppearancePreferences();
  const params = props.route.params;
  const environmentId = params.environmentId?.trim()
    ? EnvironmentId.make(params.environmentId)
    : null;
  const sizeBytes = Number.parseInt(params.sizeBytes, 10) || 0;
  const draftKey = params.draftKey ?? null;
  const draft = useComposerDraft(draftKey);
  const draftAttachment = draftKey
    ? draft.attachments.find((entry) => entry.id === params.attachmentId)
    : undefined;
  const localAttachment =
    draftAttachment && isFileBackedComposerAttachment(draftAttachment) ? draftAttachment : null;
  const document = useAttachmentDocument({
    name: params.name,
    mimeType: params.mimeType,
    sizeBytes,
    attachmentId: params.attachmentId,
    environmentId,
    attachment: localAttachment,
  });
  const [nativeOpen, setNativeOpen] = useState(false);
  const nativeKind = nativeViewerKind(document.kind);
  const [nativeViewer, setNativeViewer] = useState<"pending" | "open" | "unavailable" | null>(
    nativeKind ? "pending" : null,
  );
  const [nativeError, setNativeError] = useState<string | null>(null);
  const pendingNativeError = useRef<string | null>(null);
  const handleBack = useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
  }, [navigation]);
  const { uri, resource } = document;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Present the native document viewer once its asynchronously resolved file URI is available.
  useEffect(() => {
    if (nativeViewer !== "pending" || !uri) return;
    // oxlint-disable-next-line react/set-state-in-effect -- Presenting the viewer waits on the resolved file.
    setNativeViewer("open");
    setNativeOpen(true);
  }, [nativeViewer, uri]);
  const handleNativeOpenError = useCallback((error: unknown) => {
    pendingNativeError.current = nativeViewerErrorMessage(error);
  }, []);
  const handleNativeClose = useCallback(() => {
    setNativeOpen(false);
    const message = pendingNativeError.current;
    pendingNativeError.current = null;
    if (nativeViewer === null) {
      // A file this screen renders itself: an explicit viewer failure is worth a word.
      if (message) Dialog.alert("Could not open document", message);
      return;
    }
    if (message) {
      setNativeError(message);
      setNativeViewer("unavailable");
      return;
    }
    handleBack();
  }, [handleBack, nativeViewer, setNativeOpen, setNativeViewer, setNativeError]);
  const removeFromDraft = useCallback(() => {
    if (!draftKey) return;
    removeComposerDraftAttachment(draftKey, params.attachmentId);
    handleBack();
  }, [draftKey, handleBack, params.attachmentId]);

  const { content, renderedMode, activeMode, setRendered, share, sharing } = document;
  const menuActions = useMemo(
    () =>
      [
        renderedMode
          ? ({
              id: "preview",
              title: renderedMode === "table" ? "Table" : "Preview",
              icon: renderedMode === "table" ? "tablecells" : "eye",
              inline: true,
              onPress: () => setRendered(true),
            } as const)
          : null,
        renderedMode
          ? ({
              id: "source",
              title: "Source",
              icon: "doc.text",
              inline: true,
              onPress: () => setRendered(false),
            } as const)
          : null,
        content && activeMode === "source"
          ? ({
              id: "word-wrap",
              title: appearance.codeWordBreak ? "Disable word wrap" : "Enable word wrap",
              icon: "text.alignleft",
              inline: false,
              onPress: () => setCodeWordBreak(!appearance.codeWordBreak),
            } as const)
          : null,
        content
          ? ({
              id: "copy",
              title: content.truncated ? "Copy preview" : "Copy contents",
              icon: "doc.on.doc",
              inline: false,
              onPress: () => copyTextWithHaptic(content.text),
            } as const)
          : null,
        uri
          ? ({
              id: "share",
              title: sharing ? "Opening share sheet…" : "Save or share",
              icon: "square.and.arrow.up",
              inline: false,
              onPress: () => void share(),
            } as const)
          : null,
        uri
          ? ({
              id: "open-viewer",
              title: "Open in file viewer",
              icon: "arrow.up.left.and.arrow.down.right",
              inline: false,
              onPress: () => {
                setNativeViewer((current) => (current === null ? null : "open"));
                setNativeOpen(true);
              },
            } as const)
          : null,
        draftKey
          ? ({
              id: "remove",
              title: "Remove from draft",
              icon: "trash",
              inline: false,
              destructive: true,
              onPress: removeFromDraft,
            } as const)
          : null,
      ].filter((action) => action !== null),
    [
      appearance.codeWordBreak,
      setCodeWordBreak,
      content,
      draftKey,
      removeFromDraft,
      activeMode,
      renderedMode,
      setRendered,
      share,
      sharing,
      setNativeViewer,
      setNativeOpen,
      uri,
    ],
  );
  const selectedAction = activeMode === "source" ? "source" : "preview";
  const fileMenu: AppBarMenu = {
    title: "File actions",
    icon: "ellipsis",
    items: [
      ...(renderedMode
        ? [
            {
              id: "modes",
              inline: true,
              items: menuActions
                .filter(({ inline }) => inline)
                .map((action) => ({
                  id: action.id,
                  title: action.title,
                  icon: action.icon,
                  selected: action.id === selectedAction,
                  onPress: action.onPress,
                })),
            },
          ]
        : []),
      ...menuActions
        .filter(({ inline }) => !inline)
        .map((action) => ({
          id: action.id,
          title: action.title,
          icon: action.icon,
          destructive: "destructive" in action,
          onPress: action.onPress,
        })),
    ],
  };
  const subtitle = `${draftKey ? "Draft attachment" : "Attachment"}${sizeBytes > 0 ? ` · ${formatAttachmentSize(sizeBytes)}` : ""}`;
  const refresh = useRefreshAssetUrl(environmentId, resource);
  const capabilities = useEnvironmentServerConfig(environmentId)?.environment.capabilities;

  if (document.kind === "archive" && isZipFile(params) && !document.error) {
    const threadDraftKey =
      environmentId && params.threadId
        ? scopedThreadKey(environmentId, ThreadId.make(params.threadId))
        : null;
    return (
      <ZipArchiveView
        name={params.name}
        subtitle={subtitle}
        sizeBytes={sizeBytes}
        uri={uri}
        isLocal={localAttachment !== null}
        refresh={refresh}
        environmentId={environmentId}
        // Entries go to the thread's chat composer, also from a question-answer draft.
        draftKey={threadDraftKey ?? draftKey}
        maxAttachmentBytes={
          capabilities?.attachmentUploads && capabilities.fileAttachments
            ? clampFileAttachmentUploadBytes(capabilities.fileAttachments.maxUploadBytes)
            : undefined
        }
        onSave={() => void share()}
        onRemove={draftKey ? removeFromDraft : null}
      />
    );
  }

  // The viewer mints its own fresh URL from the resource, so a link that expired while this
  // screen sat in the background is never handed to Quick Look or ACTION_VIEW.
  const nativeSource = useMemo<FilePreviewSource | null>(() => {
    const kind = nativeKind ?? "document";
    const base = { kind, name: params.name, mimeType: params.mimeType };
    if (localAttachment) return { ...base, attachment: localAttachment };
    if (environmentId) return { ...base, environmentId, resource };
    return uri ? { ...base, uri } : null;
  }, [nativeKind, params.name, params.mimeType, localAttachment, environmentId, resource, uri]);

  return (
    <View className="flex-1 bg-sheet">
      <AppBar title={params.name} subtitle={subtitle} onBack={handleBack} menus={[fileMenu]} />
      <AttachmentDocumentBody
        document={document}
        name={params.name}
        environmentId={environmentId}
        htmlRender={params.htmlRender === "1"}
        nativeViewer={nativeViewer}
        nativeError={nativeError}
        onOpenNative={() => {
          setNativeViewer((current) => (current === null ? null : "open"));
          setNativeOpen(true);
        }}
      />
      {nativeOpen && nativeSource ? (
        <FilePreviewModal
          source={nativeSource}
          onRequestClose={handleNativeClose}
          onOpenError={handleNativeOpenError}
        />
      ) : null}
    </View>
  );
}
