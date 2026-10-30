import type { ProjectEntry } from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";
import { mergeDirectoryListings } from "./directoryListings";

const dir = (path: string): ProjectEntry => ({ path, kind: "directory" });
const file = (path: string): ProjectEntry => ({ path, kind: "file" });
describe("shallow directory listings", () => {
  it("only visits expanded levels, not cached collapsed descendants", () => {
    const root = [dir("src"), dir("vendor")];
    const listings = new Map([
      ["src", [file("src/app.ts"), dir("src/deep")]],
      ["src/deep", [file("src/deep/hidden.ts")]],
      ["vendor", Array.from({ length: 100_000 }, (_, i) => file(`vendor/${i}.ts`))],
    ]);
    expect(
      mergeDirectoryListings(root, listings, ["src"])
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(["src", "src/app.ts", "src/deep", "vendor"]);
  });
  it("does not resurrect a removed parent from its cached children", () => {
    expect(
      mergeDirectoryListings([], new Map([["gone", [file("gone/old.ts")]]]), ["gone"]),
    ).toEqual([]);
  });
  it("loads the path to an open file but does not descend into its siblings", () => {
    const listings = new Map([
      ["src", [dir("src/a"), dir("src/b")]],
      ["src/a", [file("src/a/open.ts")]],
      ["src/b", [file("src/b/hidden.ts")]],
    ]);
    expect(
      mergeDirectoryListings([dir("src")], listings, ["src", "src/a"])
        .map((entry) => entry.path)
        .sort(),
    ).toEqual(["src", "src/a", "src/a/open.ts", "src/b"]);
  });
});
