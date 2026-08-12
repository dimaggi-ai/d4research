import { describe, expect, it } from "vite-plus/test";

import { makePastedContext } from "../../lib/pastedContext";
import { formatPastedContextMeta, memoPastedContextLabel } from "./ComposerPendingPastedContexts";

describe("formatPastedContextMeta", () => {
  it("reports normalized line count and character size for a small attachment", () => {
    const context = makePastedContext({
      name: "small.txt",
      content: "one\r\ntwo\r\nthree",
      fromFile: true,
    });

    expect(formatPastedContextMeta(context)).toBe("3 lines · 13 chars");
  });

  it("reports one line and a stable kibibyte display for a large attachment", () => {
    const context = makePastedContext({
      name: "large.txt",
      content: "x".repeat(1_536),
      fromFile: true,
    });

    expect(formatPastedContextMeta(context)).toBe("1 line · 1.5 KB");
  });

  it("shows the Memo storage lifecycle on the attachment chip", () => {
    const context = {
      ...makePastedContext({ name: "large.txt", content: "preview", fromFile: true }),
      sourceContent: "x".repeat(132_277),
      contentTruncated: true,
    };

    expect(memoPastedContextLabel(context, "idle")).toBe("Memo on send");
    expect(memoPastedContextLabel(context, "saving")).toBe("Saving to Memo…");
    expect(memoPastedContextLabel(context, "failed")).toBe("Memo failed · retry");
  });
});
