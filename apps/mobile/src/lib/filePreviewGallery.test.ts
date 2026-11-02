import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@d4research/contracts";
import type { FilePreviewItem } from "../components/FilePreviewModal.types";
import { filePreviewGallery, filePreviewKey, filePreviewName } from "./filePreviewGallery";

const first: FilePreviewItem = { kind: "image", uri: "https://example.com/first.png" };
const second: FilePreviewItem = { kind: "image", uri: "https://example.com/second.png" };
import type { DraftComposerAttachment } from "./composerImages";
import { composerImageGallery } from "./composerImageGallery";
import { messageImageGallery } from "../features/threads/messageImageGallery";

vi.mock("./uuid", () => ({}));

describe("image preview groups", () => {
  it("preserves ordering, removes duplicates and retains the tapped transition source", () => {
    const selected = { ...second, sourceIdentifier: "thumbnail-2" };
    expect(filePreviewGallery(selected, [first, second, first])).toEqual([first, selected]);
  });

  it("keeps documents out of image groups and preserves a standalone image", () => {
    const document: FilePreviewItem = { kind: "pdf", uri: "file:///report.pdf" };
    expect(filePreviewGallery(first, [document])).toEqual([first]);
    expect(filePreviewGallery(document, [first, second])).toEqual([document]);
  });
  it.each([false, true])(
    "keeps one entry per image through upload and delivery (file: %s)",
    (fileBacked) => {
      const environmentId = EnvironmentId.make("test");
      const context = { environmentId, threadId: ThreadId.make("thread"), workspaceRoot: null };
      const attachments: DraftComposerAttachment[] = ["a", "b"].map((id) => ({
        id,
        type: "image",
        name: `${id}.png`,
        mimeType: "image/png",
        sizeBytes: 3,
        previewUri: `data:image/png;base64,${id}`,
        ...(fileBacked ? { fileUri: `file:///documents/${id}.png` } : {}),
      }));
      const delivered = (id: string) =>
        messageImageGallery(
          {
            text: "",
            attachments: [
              {
                type: "image",
                id: `uploaded-${id}`,
                name: `${id}.png`,
                mimeType: "image/png",
                sizeBytes: 3,
              },
            ],
          },
          context,
        )[0]!;
      const local = composerImageGallery(attachments, environmentId);
      const uploading = composerImageGallery(
        [{ ...attachments[0]!, uploadedAttachmentId: "uploaded-a" }, attachments[1]!],
        environmentId,
      );
      const uploaded = composerImageGallery(
        attachments.map((attachment) => ({
          ...attachment,
          uploadedAttachmentId: `uploaded-${attachment.id}`,
        })),
        environmentId,
      );
      for (const [selected, gallery] of [
        [local[0]!, local],
        [delivered("a"), uploading],
        [uploading[1]!, uploading],
        [delivered("a"), uploaded],
        [delivered("a"), [...uploaded, delivered("a"), delivered("b")]],
        [delivered("a"), [delivered("a"), delivered("b")]],
      ] as const) {
        const result = filePreviewGallery(selected, gallery);
        expect(result).toHaveLength(2);
        expect(result.map(filePreviewKey)).toEqual([...new Set(gallery.map(filePreviewKey))]);
      }
      expect(composerImageGallery(attachments)).toEqual(local);
    },
  );

  it("matches remote originals despite metadata and property order differences", () => {
    const environmentId = EnvironmentId.make("test");
    const a: FilePreviewItem = {
      kind: "image",
      environmentId,
      resource: { _tag: "attachment", attachmentId: "a", fileName: "old.png" },
    };
    const b: FilePreviewItem = {
      kind: "image",
      environmentId,
      resource: {
        attachmentId: "a",
        _tag: "attachment",
        fileName: "new.png",
        mimeType: "image/png",
      },
    };
    expect(filePreviewKey(a)).toBe(filePreviewKey(b));
    expect(filePreviewGallery(b, [a])).toEqual([b]);
  });

  it("uses actual filenames instead of captions with punctuation and paths", () => {
    expect(
      filePreviewName({ ...first, name: 'main: "New thread in..." shows pingdotgg/t3code' }),
    ).toBe("first.png");
    expect(
      filePreviewName({
        kind: "image",
        uri: "https://example.com/image",
        name: "test: before... / after",
      }),
    ).toBe("test_ before___ _ after");
    expect(
      filePreviewName({ kind: "document", uri: "file:///tmp/report.docx", name: "report.docx" }),
    ).toBe("report.docx");
  });
});
