import { SymbolView } from "../components/AppSymbol";
import { imageMimeType } from "@d4research/shared/image";
import { videoMimeType } from "@d4research/shared/video";
import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, ScrollView, View } from "react-native";
import { useThemeColor } from "../lib/useThemeColor";

import { AppText as Text } from "./AppText";
import { PierreEntryIcon } from "./PierreEntryIcon";
import {
  isFileBackedComposerAttachment,
  type DraftComposerAttachment,
  type DraftComposerFileAttachment,
  type DraftComposerImageAttachment,
} from "../lib/composerImages";
import { resolveOwnedComposerAttachmentFileUri } from "../lib/composerAttachmentFiles";
import { VideoAttachmentTile } from "./VideoAttachmentTile";
import { type MediaActionsSource } from "../lib/mediaActions";
import { PresentationSource } from "./NativePresentation";
import { FilePreviewModal, type FilePreviewSource } from "./FilePreviewModal";
import { VideoPreviewModal, type VideoPreviewSource } from "./VideoPreviewModal";
import { isPdfFile } from "../lib/filePreview";
import type { EnvironmentId } from "@d4research/contracts";
import {
  retryComposerAttachmentUpload,
  useComposerAttachmentUploadState,
} from "../state/composer-attachment-uploads";

export interface ComposerAttachmentStripProps {
  readonly environmentId?: EnvironmentId;
  readonly onPressImage?: (previewUri: string) => void;
  /** Attachment images to display. */
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  /** Called when the user taps the remove button on an image. */
  readonly onRemove: (imageId: string) => void;
  /** Called when the user taps an image or PDF to preview it. */
  readonly onPressPreview?: (source: FilePreviewSource) => void;
  readonly onPressVideo?: (
    attachment: DraftComposerFileAttachment,
    sourceIdentifier: string,
  ) => void;
  /** Called when the user taps a document that is not a picture, video or PDF. */
  readonly onPressDocument?: (attachment: DraftComposerFileAttachment) => void;
  /** Image thumbnail size in points.  Defaults to 72. */
  readonly imageSize?: number;
  /** Border radius of each image thumbnail.  Defaults to 16. */
  readonly imageBorderRadius?: number;
  /** Whether the remove button should sit in its own gutter instead of overlapping the image. */
  readonly removeButtonPlacement?: "overlay" | "gutter";
}

type ComposerAttachmentThumbnailProps = {
  readonly environmentId?: EnvironmentId;
  readonly attachment: DraftComposerAttachment;
  readonly size: number;
  readonly borderRadius: number;
  readonly compact?: boolean;
  readonly onPressPreview?: (source: FilePreviewSource) => void;
  readonly onPressVideo?: (
    attachment: DraftComposerFileAttachment,
    sourceIdentifier: string,
  ) => void;
  readonly onPressDocument?: (attachment: DraftComposerFileAttachment) => void;
};

export function ComposerAttachmentThumbnail(props: ComposerAttachmentThumbnailProps) {
  const upload = useComposerAttachmentUploadState(props.environmentId, props.attachment.id);
  return (
    <View style={{ width: props.size, height: props.size }}>
      <ComposerAttachmentContent {...props} />
      {upload && upload.status !== "ready" ? (
        <Pressable
          accessibilityRole={upload.status === "failed" ? "button" : "text"}
          accessibilityLabel={
            upload.status === "failed"
              ? `Retry uploading ${props.attachment.name}`
              : `Uploading ${props.attachment.name}, ${Math.floor(upload.progress * 100)}%`
          }
          accessibilityHint={upload.status === "failed" ? upload.reason : undefined}
          disabled={upload.status !== "failed"}
          onPress={() =>
            props.environmentId &&
            retryComposerAttachmentUpload(props.environmentId, props.attachment.id)
          }
          className="absolute bottom-0.5 left-0.5 flex-row items-center gap-0.5 rounded-full bg-black/70 px-1 py-0.5"
        >
          <SymbolView
            name={upload.status === "failed" ? "arrow.clockwise" : "arrow.up"}
            size={props.compact ? 8 : 10}
            tintColor="#ffffff"
            type="monochrome"
          />
          {!props.compact ? (
            <Text className="text-2xs text-white">
              {upload.status === "failed" ? "Retry" : `${Math.floor(upload.progress * 100)}%`}
            </Text>
          ) : null}
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Thumbnail URI for a draft image. File-backed previews rebase into the
 * current iOS data container (its UUID changes across installs); the raw
 * persisted URI renders meanwhile, which is correct everywhere but after a
 * container move.
 */
const PREVIEW_CACHE_DIRECTORY = "t3-composer-previews";

/**
 * Fabric re-parses an image source URL on every layout pass of the node, and a
 * multi-megabyte data URL makes each Fabric commit slow enough that concurrent
 * UI-thread commits (the question card's coverage animation) win the race every
 * time until the renderer aborts. Inline bytes are written to the cache once and
 * the thumbnail renders from that file instead.
 */
/** Roughly 192KB of base64: small enough that re-parsing it per layout stays imperceptible. */
const INLINE_PREVIEW_FALLBACK_MAX_CHARS = 256_000;

async function materializeDataUrlPreview(id: string, dataUrl: string): Promise<string | null> {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const { Directory, File, Paths } = await import("expo-file-system");
  const mimeType = /^data:([^;,]+)/.exec(dataUrl)?.[1] ?? "image/jpeg";
  const extension = (mimeType.split("/")[1] ?? "jpg").replace("jpeg", "jpg");
  const directory = new Directory(Paths.cache, PREVIEW_CACHE_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  const file = new File(directory, `${id}.${extension}`);
  if (!file.exists) {
    file.create();
    file.write(dataUrl.slice(comma + 1), { encoding: "base64" });
  }
  return file.uri;
}

/** The thumbnail source for a draft image: an owned file when there is one, never a data URL. */
function useComposerImagePreviewUri(attachment: DraftComposerImageAttachment): string | null {
  const { id, fileUri, previewUri } = attachment;
  const [rebased, setRebased] = useState<{ fileUri: string; uri: string } | null>(null);
  const [materialized, setMaterialized] = useState<{ id: string; uri: string | null } | null>(null);
  const inlinePreview = fileUri === undefined && previewUri.startsWith("data:");
  useEffect(() => {
    if (fileUri === undefined) return;
    let cancelled = false;
    void (async () => {
      const { Paths } = await import("expo-file-system");
      const owned = resolveOwnedComposerAttachmentFileUri(fileUri, Paths.document.uri);
      // Re-render only when the container actually moved.
      if (!cancelled && owned !== null && owned !== previewUri) setRebased({ fileUri, uri: owned });
    })();
    return () => {
      cancelled = true;
    };
  }, [fileUri, previewUri]);
  useEffect(() => {
    if (!inlinePreview) return;
    let cancelled = false;
    void materializeDataUrlPreview(id, previewUri)
      .then((uri) => {
        if (!cancelled && uri !== null) setMaterialized({ id, uri });
      })
      .catch((error: unknown) => {
        console.warn("[composer-attachments] could not cache an image preview", error);
        // Record the failure so the thumbnail stops waiting on a file that will never arrive.
        if (!cancelled) setMaterialized({ id, uri: null });
      });
    return () => {
      cancelled = true;
    };
  }, [id, inlinePreview, previewUri]);
  if (fileUri !== undefined && rebased?.fileUri === fileUri) return rebased.uri;
  if (fileUri !== undefined) return previewUri.startsWith("data:") ? fileUri : previewUri;
  if (inlinePreview) {
    if (materialized?.id !== id) return null;
    // Falling back to the data URL is a last resort: a large one re-parses on every layout and
    // starves the Fabric commit, which is what the cache file exists to avoid. Small ones are
    // cheap enough to render directly rather than leaving the thumbnail blank forever.
    return (
      materialized.uri ??
      (previewUri.length <= INLINE_PREVIEW_FALLBACK_MAX_CHARS ? previewUri : null)
    );
  }
  return previewUri;
}

function ComposerImageAttachment(
  props: ComposerAttachmentThumbnailProps & { readonly attachment: DraftComposerImageAttachment },
) {
  const { attachment } = props;
  const style = { width: props.size, height: props.size, borderRadius: props.borderRadius };
  const previewUri = useComposerImagePreviewUri(attachment);
  const sourceIdentifier = `draft-image:${attachment.id}`;
  return (
    <PresentationSource identifier={sourceIdentifier}>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={`Open ${attachment.name}`}
        disabled={!props.onPressPreview}
        onPress={() =>
          props.onPressPreview?.(
            // File-backed images open through the retain-lease + container
            // rebase path; legacy drafts still carry their inline bytes.
            isFileBackedComposerAttachment(attachment)
              ? { kind: "image", attachment, name: attachment.name, sourceIdentifier }
              : {
                  kind: "image",
                  uri: attachment.dataUrl ?? attachment.previewUri,
                  name: attachment.name,
                  sourceIdentifier,
                },
          )
        }
      >
        <Image
          source={previewUri === null ? undefined : { uri: previewUri }}
          style={style}
          className="bg-subtle"
          resizeMode="cover"
        />
      </Pressable>
    </PresentationSource>
  );
}

function ComposerAttachmentContent(props: ComposerAttachmentThumbnailProps) {
  const { attachment } = props;
  // The document picker types every pick as a plain file, so a picture arrives here as one.
  // What it *is* decides how it presents, the same way videos are already recognised below.
  if (attachment.type === "image" || imageMimeType(attachment) !== null) {
    // A pasted-text marker does not fit the snapshot source a picture carries.
    const { source: _droppedSource, ...rest } = attachment;
    return (
      <ComposerImageAttachment
        {...props}
        attachment={
          attachment.type === "image"
            ? attachment
            : { ...rest, type: "image", previewUri: attachment.fileUri }
        }
      />
    );
  }
  const onPressVideo = props.onPressVideo;
  if (onPressVideo && videoMimeType(attachment) !== null) {
    return (
      <ComposerVideoAttachment {...props} attachment={attachment} onPressVideo={onPressVideo} />
    );
  }
  return <ComposerFileAttachment {...props} attachment={attachment} />;
}

function ComposerFileAttachment(
  props: ComposerAttachmentThumbnailProps & { readonly attachment: DraftComposerFileAttachment },
) {
  const { attachment } = props;
  const style = { width: props.size, height: props.size, borderRadius: props.borderRadius };
  const canPreview = isPdfFile(attachment) && props.onPressPreview !== undefined;
  const sourceIdentifier = `draft-file:${attachment.id}`;
  const onPressDocument = props.onPressDocument;
  return (
    <>
      <PresentationSource identifier={sourceIdentifier}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${attachment.name}`}
          disabled={!canPreview && onPressDocument === undefined}
          onPress={() =>
            canPreview
              ? props.onPressPreview?.({
                  kind: "pdf",
                  name: attachment.name,
                  attachment,
                  sourceIdentifier,
                })
              : onPressDocument?.(attachment)
          }
          className={
            props.compact
              ? "items-center justify-center bg-subtle"
              : "items-center justify-center gap-1 bg-subtle px-2"
          }
          style={style}
        >
          <PierreEntryIcon path={attachment.name} kind="file" size={props.compact ? 15 : 22} />
          {!props.compact ? (
            <Text className="w-full text-center text-2xs text-foreground" numberOfLines={1}>
              {attachment.name}
            </Text>
          ) : null}
        </Pressable>
      </PresentationSource>
    </>
  );
}

function ComposerVideoAttachment(props: {
  readonly attachment: DraftComposerFileAttachment;
  readonly size: number;
  readonly borderRadius: number;
  readonly compact?: boolean;
  readonly onPressVideo: (
    attachment: DraftComposerFileAttachment,
    sourceIdentifier: string,
  ) => void;
}) {
  const { attachment } = props;
  const sourceIdentifier = `draft:${attachment.id}`;
  const style = { width: props.size, height: props.size, borderRadius: props.borderRadius };
  const actionsSource = useMemo<MediaActionsSource>(
    () => ({
      name: attachment.name,
      mimeType: videoMimeType(attachment) ?? attachment.mimeType,
      sourceIdentifier,
      attachment,
    }),
    [attachment, sourceIdentifier],
  );

  return (
    <VideoAttachmentTile
      name={attachment.name}
      sourceIdentifier={sourceIdentifier}
      thumbnailSource={attachment}
      compact={props.compact}
      onPress={() => props.onPressVideo(attachment, sourceIdentifier)}
      actionsSource={actionsSource}
      style={style}
    />
  );
}

/**
 * A horizontally-scrollable strip of image attachment thumbnails with remove
 * buttons.  Used by both the thread composer and the new-task draft screen.
 */
export function ComposerAttachmentStrip(props: ComposerAttachmentStripProps) {
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const [videoPreview, setVideoPreview] = useState<VideoPreviewSource | null>(null);
  const size = props.imageSize ?? 72;
  const radius = props.imageBorderRadius ?? 16;
  const removeButtonPlacement = props.removeButtonPlacement ?? "overlay";
  const removeButtonGutter = removeButtonPlacement === "gutter" ? 10 : 0;

  if (props.attachments.length === 0) {
    return null;
  }

  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        className="grow-0"
      >
        <View className="flex-row gap-2.5">
          {props.attachments.map((image) => (
            <View
              key={image.id}
              className="relative"
              style={{
                paddingTop: removeButtonGutter,
                paddingRight: removeButtonGutter,
              }}
            >
              <ComposerAttachmentThumbnail
                environmentId={props.environmentId}
                attachment={image}
                size={size}
                borderRadius={radius}
                onPressPreview={
                  props.onPressPreview ??
                  ((source) => {
                    if (props.onPressImage && source.kind === "image" && "uri" in source)
                      props.onPressImage(source.uri);
                    else setPreview(source);
                  })
                }
                onPressVideo={
                  props.onPressVideo ??
                  ((attachment, sourceIdentifier) =>
                    setVideoPreview({ type: "local", attachment, sourceIdentifier }))
                }
                onPressDocument={
                  props.onPressDocument ??
                  ((attachment) =>
                    setPreview({
                      kind: "document",
                      attachment,
                      name: attachment.name,
                      mimeType: attachment.mimeType,
                    }))
                }
              />
              <Pressable
                className="absolute h-[22px] w-[22px] items-center justify-center rounded-[11px] bg-black/55"
                style={{
                  top: removeButtonPlacement === "gutter" ? 0 : 4,
                  right: removeButtonPlacement === "gutter" ? 0 : 4,
                }}
                hitSlop={6}
                onPress={() => props.onRemove(image.id)}
              >
                <SymbolView
                  name="xmark"
                  size={9}
                  tintColor="#ffffff"
                  type="monochrome"
                  weight="bold"
                />
              </Pressable>
            </View>
          ))}
        </View>
      </ScrollView>
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
      <VideoPreviewModal source={videoPreview} onRequestClose={() => setVideoPreview(null)} />
    </>
  );
}
