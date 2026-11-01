import { describe, expect, it } from "vite-plus/test";

import { ancestorDirectories } from "./NativeProjectFileTree";

describe("ancestorDirectories", () => {
  it("returns every directory on the way to a file, excluding the file", () => {
    expect(ancestorDirectories("apps/web/src/index.ts")).toEqual([
      "apps",
      "apps/web",
      "apps/web/src",
    ]);
  });

  it("returns nothing for a top-level entry", () => {
    expect(ancestorDirectories("README.md")).toEqual([]);
    expect(ancestorDirectories("")).toEqual([]);
  });

  it("normalizes Windows separators and ignores empty segments", () => {
    expect(ancestorDirectories("apps\\web\\src\\index.ts")).toEqual([
      "apps",
      "apps/web",
      "apps/web/src",
    ]);
    expect(ancestorDirectories("apps//web///main.ts")).toEqual(["apps", "apps/web"]);
  });
});
