import { ClientSettingsSchema, type ClientSettings } from "@t3tools/contracts";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

export const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function restoreLegacyWordWrap(settings: ClientSettings): ClientSettings {
  const rawSettings = window.localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY);
  if (rawSettings === null) {
    return settings;
  }

  const persistedSettings: unknown = JSON.parse(rawSettings);
  if (
    typeof persistedSettings !== "object" ||
    persistedSettings === null ||
    Array.isArray(persistedSettings) ||
    "wordWrap" in persistedSettings ||
    typeof (persistedSettings as { diffWordWrap?: unknown }).diffWordWrap !== "boolean"
  ) {
    return settings;
  }

  return {
    ...settings,
    wordWrap: (persistedSettings as { diffWordWrap: boolean }).diffWordWrap,
  };
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  try {
    const settings = getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
    return settings === null ? null : restoreLegacyWordWrap(settings);
  } catch (error) {
    console.error("Could not read persisted client settings.", error);
    return null;
  }
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
}
