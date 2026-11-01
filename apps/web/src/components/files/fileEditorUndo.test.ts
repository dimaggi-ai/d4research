import { describe, expect, it } from "vite-plus/test";

import { resolveFileEditorHistoryAction } from "./fileEditorUndo";

const event = (overrides: Partial<KeyboardEvent> = {}) =>
  ({
    key: "z",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  }) as KeyboardEvent;

describe("resolveFileEditorHistoryAction", () => {
  it("routes both platform undo modifiers to the file editor", () => {
    expect(resolveFileEditorHistoryAction(event({ metaKey: true }))).toBe("undo");
    expect(resolveFileEditorHistoryAction(event({ ctrlKey: true }))).toBe("undo");
  });

  it("routes shifted undo to redo and ignores unrelated shortcuts", () => {
    expect(resolveFileEditorHistoryAction(event({ metaKey: true, shiftKey: true }))).toBe("redo");
    expect(resolveFileEditorHistoryAction(event({ metaKey: true, altKey: true }))).toBeNull();
    expect(resolveFileEditorHistoryAction(event({ key: "x", metaKey: true }))).toBeNull();
  });
});
