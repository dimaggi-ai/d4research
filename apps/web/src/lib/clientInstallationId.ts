import { randomUUID } from "./utils";

const CLIENT_ID_STORAGE_KEY = "t3.backgroundActivity.clientId";

export function getStableClientId(): string | null {
  try {
    const existing = window.localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (
      existing?.trim() &&
      existing === existing.trim() &&
      existing.length <= 128 &&
      existing !== "ephemeral-browser-client"
    )
      return existing;
    const next = randomUUID();
    window.localStorage.setItem(CLIENT_ID_STORAGE_KEY, next);
    return window.localStorage.getItem(CLIENT_ID_STORAGE_KEY) === next ? next : null;
  } catch {
    return null;
  }
}
