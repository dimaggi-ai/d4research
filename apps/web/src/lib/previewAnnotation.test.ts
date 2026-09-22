import { type PreviewAnnotationPayload } from "@d4research/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  appendPreviewAnnotationPrompt,
  buildPreviewAnnotationPrompt,
  capturePreviewAnnotationScreenshot,
  extractTrailingPreviewAnnotation,
} from "./previewAnnotation";

const annotation: PreviewAnnotationPayload = {
  id: "annotation_1",
  pageUrl: "http://localhost:3000",
  pageTitle: "Example",
  comment: "Make these cards feel related.",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: {
    dataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
    width: 1,
    height: 1,
    cropRect: { x: 0, y: 0, width: 1, height: 1 },
  },
  createdAt: "2026-06-11T00:00:00.000Z",
};

describe("preview annotations", () => {
  it("describes regions, drawings, styles, and screenshot context", () => {
    const result = buildPreviewAnnotationPrompt(annotation);
    expect(result).toContain("Make these cards feel related.");
    expect(result).toContain("1 marked region");
    expect(result).toContain("1 drawing");
    expect(result).toContain("border-radius: 4px → 16px");
    expect(result).toContain("attached screenshot");
  });

  it("appends to an existing composer prompt", () => {
    expect(
      appendPreviewAnnotationPrompt("Fix this", annotation).startsWith(
        "Fix this\n\n<preview_annotation>",
      ),
    ).toBe(true);
  });

  it("extracts annotation presentation from a sent prompt", () => {
    const result = extractTrailingPreviewAnnotation(
      appendPreviewAnnotationPrompt("Fix this", annotation),
    );
    expect(result.promptText).toBe("Fix this");
    expect(result.annotation).toMatchObject({
      title: "Example",
      targetSummary: "1 marked region, 1 drawing.",
      hasScreenshot: true,
    });
  });

  it("extracts multiple trailing annotations one at a time", () => {
    const first = appendPreviewAnnotationPrompt("Fix this", annotation);
    const secondAnnotation = { ...annotation, id: "annotation_2", pageTitle: "Details" };
    const second = appendPreviewAnnotationPrompt(first, secondAnnotation);
    const extractedSecond = extractTrailingPreviewAnnotation(second);
    const extractedFirst = extractTrailingPreviewAnnotation(extractedSecond.promptText);
    expect(extractedSecond.annotation?.id).toBe("annotation_2");
    expect(extractedFirst.annotation?.id).toBe("annotation_1");
    expect(extractedFirst.promptText).toBe("Fix this");
  });
});

describe("preview annotation capture", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves the PNG bytes, MIME type, and filename without fetching", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Blocked by connect-src"));
    vi.stubGlobal("fetch", fetch);
    const capture = capturePreviewAnnotationScreenshot(annotation);
    expect(capture.status).toBe("captured");
    if (capture.status !== "captured") throw new Error("Expected a screenshot file");
    expect(capture.file.name).toBe("preview-annotation-annotation_1.png");
    expect(capture.file.type).toBe("image/png");
    expect(Buffer.from(await capture.file.arrayBuffer()).toString("hex")).toBe(
      "89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c020000000b4944415478da63fcff1f0003030200efa2a75b0000000049454e44ae426082",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports none when the annotation carries no crop", () => {
    const capture = capturePreviewAnnotationScreenshot({ ...annotation, screenshot: null });
    expect(capture).toEqual({ status: "none" });
  });

  it.each(["data:image/jpeg;base64,AA==", "data:image/png;base64,", "data:image/png;base64,%%%"])(
    "reports a malformed screenshot as failed: %s",
    (dataUrl) => {
      const picked = { ...annotation, screenshot: { ...annotation.screenshot!, dataUrl } };
      expect(capturePreviewAnnotationScreenshot(picked)).toEqual({ status: "failed" });
    },
  );
});
