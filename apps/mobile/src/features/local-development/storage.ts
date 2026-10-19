import Storage from "expo-sqlite/kv-store";
import * as SecureStore from "expo-secure-store";
import { decodeWorkspace, type LocalWorkspace } from "./workspace";
const WORKSPACE_KEY = "d4.local-development.workspace.v1";
const API_KEY = "d4.local-development.api-key.v1";
export const loadLocalWorkspace = async () =>
  decodeWorkspace(await Storage.getItemAsync(WORKSPACE_KEY));
export const saveLocalWorkspace = (workspace: LocalWorkspace, expected: LocalWorkspace) =>
  Storage.setItemAsync(WORKSPACE_KEY, (previous) => {
    if (
      JSON.stringify(decodeWorkspace(previous)) !==
      JSON.stringify(decodeWorkspace(JSON.stringify(expected)))
    )
      throw new Error("The workspace changed in another screen. Reopen it before saving changes.");
    return JSON.stringify(workspace);
  });
export const loadLocalApiKey = async (endpoint: string) => {
  const raw = await SecureStore.getItemAsync(API_KEY);
  if (!raw) return null;
  const value = JSON.parse(raw);
  return value.endpoint === endpoint && typeof value.key === "string" ? value.key : null;
};
export const saveLocalApiKey = (endpoint: string, key: string) =>
  key
    ? SecureStore.setItemAsync(API_KEY, JSON.stringify({ endpoint, key }), {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      })
    : SecureStore.deleteItemAsync(API_KEY);
