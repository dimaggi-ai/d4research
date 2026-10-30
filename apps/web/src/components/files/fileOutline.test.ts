import { describe, expect, it } from "vite-plus/test";

import { parseFileOutline } from "./fileOutline";

describe("parseFileOutline", () => {
  it("extracts Python classes and methods with nesting depth", () => {
    const source = [
      "import os",
      "",
      "def top_level():",
      "    pass",
      "",
      "class AWSVMClient(Client):",
      "    def __repr__(self):",
      "        return ''",
      "    def is_equal(self, other):",
      "        return True",
    ].join("\n");

    const outline = parseFileOutline(source, "src/decorators.py");
    expect(outline).toEqual([
      { name: "top_level", kind: "function", lineNumber: 3, depth: 0 },
      { name: "AWSVMClient", kind: "class", lineNumber: 6, depth: 0 },
      { name: "__repr__", kind: "method", lineNumber: 7, depth: 1 },
      { name: "is_equal", kind: "method", lineNumber: 9, depth: 1 },
    ]);
  });

  it("extracts TypeScript classes, interfaces, functions, and arrow consts", () => {
    const source = [
      "export interface Foo { a: number }",
      "export function doThing() {}",
      "const handler = () => {};",
      "export class Bar {",
      "  run(self: string): void {",
      "    return;",
      "  }",
      "}",
    ].join("\n");

    const outline = parseFileOutline(source, "src/x.ts");
    expect(outline.map((symbol) => `${symbol.kind}:${symbol.name}:${symbol.depth}`)).toEqual([
      "interface:Foo:0",
      "function:doThing:0",
      "function:handler:0",
      "class:Bar:0",
      "method:run:1",
    ]);
  });

  it("returns an empty outline for files with no declarations", () => {
    expect(parseFileOutline("just some text\nmore text", "notes.txt")).toEqual([]);
  });
});
