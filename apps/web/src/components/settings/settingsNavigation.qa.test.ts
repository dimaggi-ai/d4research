import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";
import { SETTINGS_SEARCH_ITEMS, SETTINGS_SECTION_LABELS } from "./settingsSearch";

const EXPECTED_SETTINGS_SCREENS = [
  "/settings/general",
  "/settings/appearance",
  "/settings/keybindings",
  "/settings/providers",
  "/settings/source-control",
  "/settings/connections",
  "/settings/tool-guard",
  "/settings/beta",
  "/settings/archived",
] as const;

describe("settings navigation QA", () => {
  it("registers one navigation button for every user-facing settings screen", () => {
    const destinations = SETTINGS_NAV_ITEMS.map((item) => item.to);

    expect(destinations).toEqual(EXPECTED_SETTINGS_SCREENS);
    expect(new Set(destinations).size).toBe(destinations.length);
    expect(SETTINGS_NAV_ITEMS.every((item) => item.label.trim().length > 0)).toBe(true);
  });

  it("keeps screen labels and navigation buttons in sync", () => {
    expect(SETTINGS_NAV_ITEMS.map(({ to, label }) => [to, label])).toEqual(
      Object.entries(SETTINGS_SECTION_LABELS),
    );
  });

  it("routes every settings search result to a visible settings screen", () => {
    const destinations = new Set(SETTINGS_NAV_ITEMS.map((item) => item.to));
    const invalidResults = SETTINGS_SEARCH_ITEMS.filter((item) => !destinations.has(item.to));

    expect(invalidResults).toEqual([]);
  });
});
