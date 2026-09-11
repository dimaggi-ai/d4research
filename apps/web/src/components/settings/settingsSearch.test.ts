import { describe, expect, it } from "vite-plus/test";

import {
  searchableSetting,
  searchSettings,
  SETTINGS_SEARCH_ITEMS,
  type SettingsSearchItem,
} from "./settingsSearch";

const ITEMS: ReadonlyArray<SettingsSearchItem> = [
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/general",
  },
  {
    id: "network-access",
    title: "Network access",
    to: "/settings/connections",
    searchTerms: ["remote pairing backend"],
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
    searchTerms: ["claude codex agents"],
  },
  {
    id: "provider-updates",
    title: "Update checks",
    to: "/settings/general",
  },
  {
    id: "automatic-updates",
    title: "Automatic updates",
    to: "/settings/general",
  },
];

describe("searchSettings", () => {
  it("matches setting titles, sections, and search aliases", () => {
    expect(searchSettings("word", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("network", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("connections", ITEMS).map((item) => item.id)).toEqual(["network-access"]);
    expect(searchSettings("claude", ITEMS).map((item) => item.id)).toEqual(["providers"]);
  });

  it("matches normalized title substrings", () => {
    expect(searchSettings("  WORD   WRAP  ", ITEMS).map((item) => item.id)).toEqual(["word-wrap"]);
    expect(searchSettings("glass").map((item) => item.id)).toEqual(["setting-glass-opacity"]);
    expect(searchSettings("xyzzy")).toEqual([]);
  });

  it("keeps catalog order for multiple title matches", () => {
    expect(searchSettings("update", ITEMS).map((item) => item.id)).toEqual([
      "provider-updates",
      "automatic-updates",
    ]);
  });

  it("matches query words across fields and ranks the strongest result first", () => {
    expect(searchSettings("pairing remote", ITEMS).map((item) => item.id)).toEqual([
      "network-access",
    ]);
    expect(
      searchSettings("remote pairing")
        .slice(0, 2)
        .map((item) => item.id),
    ).toEqual(["network-access", "connections-environment"]);
  });

  it("finds settings that used to be reachable only through their section", () => {
    expect(searchSettings("pull request template")[0]?.id).toBe("follow-change-request-templates");
    expect(searchSettings("git security keys")[0]?.id).toBe("git-fetch-interval");
    expect(searchSettings("push notifications")).toEqual([]);
    expect(searchSettings("battery saver")[0]?.id).toBe("background-activity");
    expect(searchSettings("binary path")[0]?.id).toBe("providers");
    expect(searchSettings("Antigravity")[0]?.id).toBe("providers");
    expect(searchSettings("Google sign in")[0]?.id).toBe("providers");
    expect(searchSettings("authorized clients")[0]?.id).toBe("connections-environment");
    expect(searchSettings("administrative access")[0]?.id).toBe("connections-environment");
  });

  it("lists thread confirmations in panel order", () => {
    expect(searchSettings("confirmation").map((item) => item.id)).toEqual([
      "unpin-confirmation",
      "archive-confirmation",
      "delete-confirmation",
    ]);
  });

  it.each(["usage providers", "CLIProxyAPI", "CLI proxy hub", "management key"])(
    "finds usage-provider management by %s",
    (query) => {
      expect(searchSettings(query)[0]).toMatchObject({
        id: "usage-providers",
        to: "/settings/providers",
      });
    },
  );
  it("returns no results for an empty query", () => {
    expect(searchSettings("   ", ITEMS)).toEqual([]);
  });

  it("keeps catalog result ids unique", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes restored local controls without advertising hosted-only features", () => {
    const ids = SETTINGS_SEARCH_ITEMS.map((item) => String(item.id));
    expect(ids).toContain("composer-collapse");
    expect(ids).toContain("legacy-plan-mode");
    expect(searchSettings("push notifications")).toEqual([]);
    expect(searchSettings("handoff")[0]?.id).toBe("handoff");
    expect(searchSettings("tool guard")[0]?.to).toBe("/settings/tool-guard");
  });

  it("serves anchor props to panels from the catalog", () => {
    expect(searchableSetting("word-wrap")).toEqual({ id: "word-wrap", title: "Word wrap" });
    expect(searchableSetting("archive")).toEqual({ id: "archive", title: "Archived threads" });
  });

  it("routes appearance settings to their current section", () => {
    expect(searchSettings("theme")[0]).toMatchObject({
      id: "theme",
      to: "/settings/appearance",
    });
    expect(searchSettings("word wrap")[0]).toMatchObject({
      id: "word-wrap",
      to: "/settings/appearance",
    });
    expect(searchSettings("environment identification")[0]).toMatchObject({
      id: "environment-identification",
      to: "/settings/appearance",
      targetId: "appearance",
    });
  });

  it("routes conditional window capture settings to the stable toggle row", () => {
    const targets = [
      "capture accessibility data",
      "capture shortcut",
      "capture sound",
      "capture flash",
      "capture animations",
    ].map((query) => {
      const match = searchSettings(query)[0];
      return [match?.id, match?.targetId];
    });

    expect(targets).toEqual([
      ["snap-shot-accessibility", "snap-shot-enabled"],
      ["snap-shot-shortcut", "snap-shot-enabled"],
      ["snap-shot-sound", "snap-shot-enabled"],
      ["snap-shot-flash", "snap-shot-enabled"],
      ["snap-shot-animations", "snap-shot-enabled"],
    ]);
  });

  it("routes browser recording quality to integrations", () => {
    const result = searchSettings("recording frame rate")[0];
    expect(result).toMatchObject({
      id: "browser-recording-frame-rate",
      to: "/settings/integrations",
    });
    expect(result).not.toHaveProperty("targetId");
  });

  it("routes where links open to integrations", () => {
    expect(searchSettings("open links in")[0]).toMatchObject({
      id: "browser-link-target",
      to: "/settings/integrations",
    });
    expect(searchSettings("external links")[0]).toMatchObject({ id: "browser-link-target" });
  });

  it("finds the default browser profile action in the profiles list", () => {
    expect(searchSettings("default profile")[0]).toMatchObject({
      id: "browser-default-profile",
      to: "/settings/integrations",
      targetId: "browser-profiles",
    });
  });
});
