import type { KeybindingShortcut } from "@d4research/contracts";

// Matching only: the desktop preview guest bundles this file without the rest of the
// keybindings module, so it stays free of parsing, defaults, and contracts runtime code.

export interface ShortcutEventLike {
  getModifierState?: (key: "AltGraph") => boolean;
  type?: string;
  code?: string;
  key: string;
  repeat?: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface ShortcutModifierStateLike {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export const EVENT_CODE_SHORTCUT_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  Slash: "/",
};

const MAC_SECTION_SIGN_CODES = new Set(["Backquote", "IntlBackslash"]);

export function isMacPlatform(platform: string): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform);
}

export function normalizeEventKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") return "escape";
  return normalized;
}

export function shortcutKeyFromEvent(event: Pick<ShortcutEventLike, "key" | "code">): string {
  const layoutKey = normalizeEventKey(event.key);
  if (/^[a-z]$/.test(layoutKey)) return layoutKey;
  const physicalKey = event.code ? EVENT_CODE_SHORTCUT_KEYS[event.code] : undefined;
  return physicalKey ?? layoutKey;
}

export function resolveEventKeys(event: ShortcutEventLike): Set<string> {
  const layoutKey = normalizeEventKey(event.key);
  const keys = new Set([layoutKey]);
  // The dedicated macOS ISO key is labelled `§` and produces `±` with Shift. Electron has
  // reported the shifted key as `±`, `§`, and `Unidentified` across releases. Preserve the
  // physical pair so a binding recorded by Settings continues to work after an Electron update.
  if (layoutKey === "±") {
    keys.add("§");
  }
  if (event.shiftKey && layoutKey === "§") {
    keys.add("±");
  }
  if (event.code && MAC_SECTION_SIGN_CODES.has(event.code)) {
    keys.add("§");
    keys.add(event.shiftKey ? "±" : "§");
  }

  const letterCode = event.code?.match(/^Key([A-Z])$/)?.[1];
  if (letterCode && !/^[a-z]$/.test(layoutKey)) {
    keys.add(letterCode.toLowerCase());
  }
  keys.add(shortcutKeyFromEvent(event));
  return keys;
}

export function matchesKeybindingShortcutModifiers(
  event: ShortcutModifierStateLike,
  shortcut: KeybindingShortcut,
  platform: string,
): boolean {
  const useMetaForMod = isMacPlatform(platform);
  const expectedMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const expectedCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  return (
    event.metaKey === expectedMeta &&
    event.ctrlKey === expectedCtrl &&
    event.shiftKey === shortcut.shiftKey &&
    event.altKey === shortcut.altKey
  );
}

export function matchesKeybindingShortcut(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform: string,
): boolean {
  if (
    !isMacPlatform(platform) &&
    event.getModifierState?.("AltGraph") &&
    !/^[a-z0-9]$/i.test(event.key)
  )
    return false;
  // On some macOS keyboard layouts the dedicated section-sign key arrives with Option asserted.
  // Settings intentionally records that physical key as plain `§`, so runtime matching must make
  // the same normalization or the composer wins before the configured command can run.
  const layoutKey = normalizeEventKey(event.key);
  const isSectionSignPhysicalKey =
    layoutKey === "§" ||
    layoutKey === "±" ||
    (event.code !== undefined && MAC_SECTION_SIGN_CODES.has(event.code));
  const modifierEvent =
    !shortcut.altKey && (shortcut.key === "§" || shortcut.key === "±") && isSectionSignPhysicalKey
      ? { ...event, altKey: false, shiftKey: event.shiftKey || layoutKey === "±" }
      : event;
  // A saved literal `±` also represents the shifted ISO key, even if an older recorder
  // omitted Shift. New recordings use `shift+§` and must match the same event.
  const modifierShortcut = shortcut.key === "±" ? { ...shortcut, shiftKey: true } : shortcut;
  if (!matchesKeybindingShortcutModifiers(modifierEvent, modifierShortcut, platform)) return false;
  return resolveEventKeys(event).has(shortcut.key);
}
