import type { KeybindingShortcut } from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchesKeybindingShortcut, type ShortcutEventLike } from "./keybindingMatching.ts";

const shortcut = (key: string, shiftKey = false): KeybindingShortcut => ({
  key,
  shiftKey,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  modKey: false,
});

const event = (overrides: Partial<ShortcutEventLike>): ShortcutEventLike => ({
  key: "Unidentified",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

describe("ISO section-sign matching in desktop preview", () => {
  it("matches plain § with the layout's extra Option modifier", () => {
    for (const keyEvent of [
      event({ key: "§", altKey: true }),
      event({ code: "Backquote", altKey: true }),
      event({ code: "IntlBackslash", altKey: true }),
    ]) {
      expect(matchesKeybindingShortcut(keyEvent, shortcut("§"), "MacIntel")).toBe(true);
      expect(
        matchesKeybindingShortcut({ ...keyEvent, ctrlKey: true }, shortcut("§"), "MacIntel"),
      ).toBe(false);
    }
  });

  it("matches shifted ISO variants against legacy ± and recorded shift+§ bindings", () => {
    for (const keyEvent of [
      event({ key: "±", code: "Backquote" }),
      event({ key: "§", code: "Backquote", shiftKey: true }),
      event({ code: "IntlBackslash", shiftKey: true, altKey: true }),
    ]) {
      expect(matchesKeybindingShortcut(keyEvent, shortcut("±"), "MacIntel")).toBe(true);
      expect(matchesKeybindingShortcut(keyEvent, shortcut("§", true), "MacIntel")).toBe(true);
      expect(matchesKeybindingShortcut(keyEvent, shortcut("§"), "MacIntel")).toBe(false);
    }
  });
});
