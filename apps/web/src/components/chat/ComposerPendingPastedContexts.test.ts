import { describe, expect, it } from "vite-plus/test";

import { makePastedContext } from "../../lib/pastedContext";
import { formatPastedContextMeta } from "./ComposerPendingPastedContexts";

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
});
