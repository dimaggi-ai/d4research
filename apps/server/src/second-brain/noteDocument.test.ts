import { describe, it, expect } from "@effect/vitest";
import {
  parseNote,
  noteTemplate,
  validName,
  applyEdit,
  contentHash,
  generatedIndex,
  INDEX_MARKER,
} from "./noteDocument.ts";

describe("note documents", () => {
  it.each(["note", "person", "project", "decision", "learning"] as const)(
    "round trips %s templates",
    (kind) => {
      const parsed = parseNote(
        "notes/a.md",
        noteTemplate(kind, "Alice: notes", "id-1", "2026-10-18"),
      );
      expect(parsed.metadata).toMatchObject({ kind, title: "Alice: notes", id: "id-1", tags: [] });
      expect(parsed.chunks[0]?.startLine).toBe(13);
    },
  );
  it("parses quoted inline and block lists with source line offsets", () => {
    const note = parseNote(
      "notes/a.md",
      '---\ntitle: "A, B"\ntags: ["a,b", c]\naliases:\n  - \'Other name\'\n---\n# Title\nBody\n## More\nText',
    );
    expect(note.metadata.tags).toEqual(["a,b", "c"]);
    expect(note.metadata.aliases).toEqual(["Other name"]);
    expect(note.chunks.map((c) => [c.startLine, c.endLine])).toEqual([
      [7, 8],
      [9, 10],
    ]);
  });
  it("ignores fenced and inline code links", () => {
    const note = parseNote(
      "notes/a.md",
      "# A\n[[target|label]] [[other#Heading]] [link](../people/alice.md)\n```md\n[[hidden]]\n```\n`[[inline]]`",
    );
    expect(note.links.map((l) => l.target)).toEqual(["target", "other", "../people/alice.md"]);
    expect(note.links[1]?.fragment).toBe("Heading");
  });
  it.each([
    "---\ntags: &alias bad\n---",
    "---\nkind: invalid\n---",
    "---\ntitle: x\ntitle: y\n---",
    '---\ntitle: "unterminated\n---',
  ])("rejects malformed YAML %s", (text) => expect(() => parseNote("a.md", text)).toThrow());
  it("allows protocol names and checks topic naming", () => {
    expect(validName("AGENTS.md")).toBe(true);
    expect(validName("people/alice-smith.md")).toBe(true);
    expect(validName("people/Alice Smith.md")).toBe(false);
  });
  it("replaces only a uniquely named section", () => {
    const input = {
      path: "a.md",
      kind: "note" as const,
      operation: "replace-section" as const,
      content: "new",
      heading: "One",
      expectedHash: "x",
    };
    expect(applyEdit("# A\n## One\nold\n## Two\nkeep", input)).toBe(
      "# A\n## One\nnew\n## Two\nkeep",
    );
    expect(() => applyEdit("## One\nx\n## One\ny", input)).toThrow();
  });
  it("generates deterministic index text", () => {
    const a = parseNote("notes/a.md", "# A\nAlpha"),
      b = parseNote("people/b.md", "# B\nBeta");
    expect(generatedIndex([a, b])).toBe(generatedIndex([b, a]));
    expect(generatedIndex([a])).toContain(INDEX_MARKER);
    expect(contentHash("x")).not.toBe(contentHash("y"));
  });
});
it("bounds chunks for long Unicode lines", () => {
  const note = parseNote("a.md", `# Heading\n${"世".repeat(20000)}`);
  expect(note.chunks.every((c) => Buffer.byteLength(c.text) <= 32768)).toBe(true);
  expect(
    note.chunks
      .slice(1)
      .map((c) => c.text)
      .join(""),
  ).toBe("世".repeat(20000));
});
it("section edits ignore headings in fenced examples", () => {
  const text =
    "# A\n```md\n## Target\n```\n## Target\nold\n```\n# not an ending\n```\n## Keep\nkeep";
  expect(
    applyEdit(text, {
      path: "a.md",
      kind: "note",
      operation: "replace-section",
      content: "new",
      heading: "Target",
      expectedHash: "h",
    }),
  ).toBe("# A\n```md\n## Target\n```\n## Target\nnew\n## Keep\nkeep");
});
