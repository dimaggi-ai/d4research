import { describe, expect, it } from "vite-plus/test";

import {
  boundedSelectableSourceTokens,
  prepareSourceFileDocument,
  selectableSourceHtml,
} from "./source-file-document";

describe("prepareSourceFileDocument", () => {
  it("normalizes and serializes source rows once for repeated consumers", () => {
    const first = prepareSourceFileDocument("const value = 1;\r\n\tvalue;\r");
    const second = prepareSourceFileDocument("const value = 1;\r\n\tvalue;\r");
    const rows = JSON.parse(first.rowsJson) as ReadonlyArray<{ readonly content: string }>;

    expect(first.contents).toBe("const value = 1;\n\tvalue;\n");
    expect(first.lines).toEqual(["const value = 1;", "\tvalue;", ""]);
    expect(rows.map((row) => row.content)).toEqual(["const value = 1;", "    value;", ""]);
    expect(second).toBe(first);
  });
});

it("bounds selectable highlighting without allocating spans for huge files", () => {
  const token = { content: "text", color: "#fff", fontStyle: null };
  const small = [[token]];
  expect(boundedSelectableSourceTokens(small)).toBe(small);
  expect(boundedSelectableSourceTokens(null)).toBeNull();
  expect(boundedSelectableSourceTokens(Array.from({ length: 20_000 }, () => [token]))).toBeNull();
  expect(boundedSelectableSourceTokens([Array.from({ length: 2_000 }, () => token)])).toBeNull();
  const longPlainText = "full contents\n".repeat(50_000);
  expect(prepareSourceFileDocument(longPlainText).contents).toBe(longPlainText);
});

it("preserves source whitespace and markup as literal selectable text", () => {
  const source = prepareSourceFileDocument(
    "\n\tlead\r\n<script>alert(1)</script> &amp; > 😀\u00a0end\n",
  );
  const html = selectableSourceHtml(source.contents, {
    foreground: "#000000",
    selection: "#3366ff",
    fontSize: 14,
    rowHeight: 24,
    wordBreak: true,
  });
  const page = new DOMParser().parseFromString(html, "text/html");

  expect(page.querySelector("script")).toBeNull();
  expect(page.body.textContent).toBe("\n\tlead\n<script>alert(1)</script> &amp; > 😀\u00a0end\n");
  expect(page.getElementById("L2")?.textContent).toBe("\tlead");
});
