import { describe, expect, it } from "vite-plus/test";

import {
  SETTINGS_NAV_GROUPS,
  SETTINGS_SEARCH_ITEMS,
  SETTINGS_SECTION_LABELS,
  settingsForThisPlatform,
} from "./settingsSearch";
import { isSecretsFeatureEnabled } from "../../env";

const D4_SETTINGS_SCREENS = [
  "/settings/research",
  "/settings/second-brain",
  "/settings/dev-pipelines",
  "/settings/skills",
  "/settings/tool-guard",
] as const;

// Detail pages reached from another page rather than the sidebar.
const DETAIL_PAGES: ReadonlySet<string> = new Set(["/settings/diagnostics"]);

describe("settings navigation QA", () => {
  const destinations = SETTINGS_NAV_GROUPS.flatMap((group) => group.paths);

  it("registers each d4research settings screen once in the sidebar", () => {
    expect(destinations).toEqual(expect.arrayContaining([...D4_SETTINGS_SCREENS]));
    expect(new Set(destinations).size).toBe(destinations.length);
  });

  it("gives every labelled screen a sidebar entry", () => {
    const labelled = Object.keys(SETTINGS_SECTION_LABELS).filter(
      (to) => !DETAIL_PAGES.has(to) && (to !== "/settings/secrets" || isSecretsFeatureEnabled),
    );
    expect(new Set(destinations)).toEqual(new Set(labelled));
  });

  it("routes every settings search result to a visible settings screen", () => {
    const visible = new Set<string>([...destinations, ...DETAIL_PAGES]);
    expect(
      settingsForThisPlatform(SETTINGS_SEARCH_ITEMS).filter((item) => !visible.has(item.to)),
    ).toEqual([]);
  });
});
