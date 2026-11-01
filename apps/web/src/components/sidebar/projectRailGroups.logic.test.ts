import { describe, expect, it } from "vite-plus/test";

import {
  addToRailGroup,
  buildRailLayout,
  createRailGroup,
  flattenRailModel,
  moveRailGroup,
  moveRailProject,
  moveRailTokenToEnd,
  nextRailGroupColor,
  placeRailProject,
  placeRailToken,
  railGroupIdFromScopeKey,
  railGroupScopeKey,
  railGroupShortLabel,
  railModelFromLayout,
  removeFromRailGroup,
  sanitizeRailGroups,
  ungroupRailGroup,
  type RailGroup,
  type RailModel,
} from "./projectRailGroups.logic";

const group = (id: string, members: string[], overrides: Partial<RailGroup> = {}): RailGroup => ({
  id,
  name: id,
  color: "blue",
  collapsed: false,
  members,
  ...overrides,
});

const model = (keys: string[], groups: RailGroup[]): RailModel =>
  railModelFromLayout(buildRailLayout(keys, groups), groups);

const flat = (next: RailModel, keys: string[]) => flattenRailModel(next, new Set(keys));

describe("buildRailLayout", () => {
  it("hides settled projects and empty groups without changing saved membership or order", () => {
    const keys = ["a", "b", "c", "d"];
    const groups = [group("g", ["c", "b"])];
    const original = buildRailLayout(keys, groups);
    expect(buildRailLayout(keys, groups, new Set(["b", "c"]))).toEqual([
      { kind: "project", key: "a" },
      { kind: "project", key: "d" },
    ]);
    expect(buildRailLayout(keys, groups, new Set(["c"]))).toEqual([
      { kind: "project", key: "a" },
      { kind: "group", group: groups[0], members: ["b"] },
      { kind: "project", key: "d" },
    ]);
    expect(buildRailLayout(keys, groups)).toEqual(original);
    expect(groups[0]?.members).toEqual(["c", "b"]);
  });

  it("places a group at its first member and keeps member order", () => {
    const entries = buildRailLayout(["a", "b", "c", "d"], [group("g", ["c", "b"])]);
    expect(entries).toEqual([
      { kind: "project", key: "a" },
      { kind: "group", group: group("g", ["c", "b"]), members: ["c", "b"] },
      { kind: "project", key: "d" },
    ]);
  });

  it("hides unknown members and groups with none left", () => {
    const entries = buildRailLayout(["a"], [group("g", ["gone", "a"]), group("h", ["gone2"])]);
    expect(entries).toEqual([{ kind: "group", group: group("g", ["gone", "a"]), members: ["a"] }]);
  });
});

describe("rail model operations", () => {
  const keys = ["a", "b", "c", "d"];

  it("creates a group where its earliest project was", () => {
    const next = createRailGroup(model(keys, []), ["c", "b"], { id: "g", name: "", color: "red" });
    expect(next.order).toEqual(["p:a", "g:g", "p:d"]);
    expect(next.groups[0]?.members).toEqual(["c", "b"]);
    expect(flat(next, keys)).toEqual(["a", "c", "b", "d"]);
  });

  it("moves a project between groups and drops the group it empties", () => {
    const start = model(keys, [group("g", ["a"]), group("h", ["c", "d"])]);
    const next = addToRailGroup(start, "a", "h");
    expect(next.groups.map((candidate) => candidate.id)).toEqual(["h"]);
    expect(next.groups[0]?.members).toEqual(["c", "d", "a"]);
    expect(next.order).toEqual(["p:b", "g:h"]);
  });

  it("expands a collapsed group that receives a project", () => {
    const next = addToRailGroup(model(keys, [group("g", ["b"], { collapsed: true })]), "a", "g");
    expect(next.groups[0]?.collapsed).toBe(false);
  });

  it("puts a removed project right after its group", () => {
    const next = removeFromRailGroup(model(keys, [group("g", ["a", "b"])]), "a");
    expect(next.order).toEqual(["g:g", "p:a", "p:c", "p:d"]);
    expect(flat(next, keys)).toEqual(["b", "a", "c", "d"]);
  });

  it("ungroups in place", () => {
    const next = ungroupRailGroup(model(keys, [group("g", ["c", "b"])]), "g");
    expect(next.groups).toEqual([]);
    expect(next.order).toEqual(["p:a", "p:c", "p:b", "p:d"]);
  });

  it("moves projects inside their container", () => {
    const start = model(keys, [group("g", ["b", "c"])]);
    expect(moveRailProject(start, "c", -1).groups[0]?.members).toEqual(["c", "b"]);
    expect(moveRailProject(start, "a", 1).order).toEqual(["g:g", "p:a", "p:d"]);
    expect(moveRailProject(start, "a", -1)).toBe(start);
    expect(moveRailGroup(start, "g", 1).order).toEqual(["p:a", "p:d", "g:g"]);
  });

  it("joins the target's group when placed next to a member", () => {
    const next = placeRailProject(model(keys, [group("g", ["b", "c"])]), "d", "b", true);
    expect(next.groups[0]?.members).toEqual(["b", "d", "c"]);
    expect(next.order).toEqual(["p:a", "g:g"]);
  });

  it("leaves a group when placed among top-level projects", () => {
    const next = placeRailProject(model(keys, [group("g", ["b", "c"])]), "b", "d", false);
    expect(next.groups[0]?.members).toEqual(["c"]);
    expect(next.order).toEqual(["p:a", "g:g", "p:b", "p:d"]);
  });

  it("moves groups and projects as top-level tokens", () => {
    const start = model(keys, [group("g", ["c", "d"])]);
    expect(placeRailToken(start, "g:g", "p:a", false).order).toEqual(["g:g", "p:a", "p:b"]);
    expect(placeRailToken(start, "p:c", "g:g", false).order).toEqual(["p:a", "p:b", "p:c", "g:g"]);
    expect(moveRailTokenToEnd(start, "p:a").order).toEqual(["p:b", "g:g", "p:a"]);
  });
});

describe("rail group helpers", () => {
  it("shortens names to fit the chip", () => {
    expect(railGroupShortLabel("Trading")).toBe("Trading");
    expect(railGroupShortLabel("Infrastructure")).toBe("Infra");
    expect(railGroupShortLabel("T3 Code")).toBe("T3");
    expect(railGroupShortLabel("Home lab")).toBe("Home");
    expect(railGroupShortLabel("Machine learning ops")).toBe("MLO");
    expect(railGroupShortLabel("  ")).toBe("Group");
  });

  it("round-trips group scope keys", () => {
    expect(railGroupIdFromScopeKey(railGroupScopeKey("rg-1"))).toBe("rg-1");
    expect(railGroupIdFromScopeKey("environment:project")).toBeNull();
    expect(railGroupIdFromScopeKey(null)).toBeNull();
  });

  it("picks an unused colour before gray", () => {
    expect(nextRailGroupColor([group("g", ["a"], { color: "red" })])).toBe("orange");
  });

  it("drops malformed and duplicate groups when reading storage", () => {
    expect(
      sanitizeRailGroups([
        { id: "g", name: 4, color: "neon", collapsed: "yes", members: ["a", "a", 3] },
        { id: "g", members: ["b"] },
        { id: "h", members: ["a", "c"] },
        { id: "", members: ["d"] },
        { id: "empty", members: [] },
        null,
      ]),
    ).toEqual([
      { id: "g", name: "", color: "gray", collapsed: false, members: ["a"] },
      { id: "h", name: "", color: "gray", collapsed: false, members: ["c"] },
    ]);
    expect(sanitizeRailGroups("nope")).toEqual([]);
  });
});
