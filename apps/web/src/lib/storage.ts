import { Debouncer } from "@tanstack/react-pacer";
import type { PersistStorage, StorageValue } from "zustand/middleware";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export interface DebouncedStorage<R = unknown> extends StateStorage<R> {
  flush: () => void;
}

export interface DebouncedPersistStorage<S> extends PersistStorage<S> {
  flush: () => void;
}

export function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

export function isStateStorage(
  storage: Partial<StateStorage> | null | undefined,
): storage is StateStorage {
  return (
    storage !== null &&
    storage !== undefined &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  );
}

export function resolveStorage(storage: Partial<StateStorage> | null | undefined): StateStorage {
  return isStateStorage(storage) ? storage : createMemoryStorage();
}

export function createDebouncedStorage(
  baseStorage: Partial<StateStorage> | null | undefined,
  debounceMs: number = 300,
): DebouncedStorage {
  const resolvedStorage = resolveStorage(baseStorage);
  const debouncedSetItem = new Debouncer(
    (name: string, value: string) => {
      resolvedStorage.setItem(name, value);
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name) => resolvedStorage.getItem(name),
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      resolvedStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}

/**
 * Debounce the JSON serialization itself, not only localStorage.setItem.
 * Zustand's createJSONStorage stringifies before calling a debounced string
 * store, which still serializes large pasted contexts on every keystroke.
 */
export function createDebouncedJsonStorage<S>(
  baseStorage: Partial<StateStorage> | null | undefined,
  debounceMs: number = 300,
): DebouncedPersistStorage<S> {
  const resolvedStorage = resolveStorage(baseStorage);
  const parse = (value: string | null): StorageValue<S> | null =>
    value === null ? null : (JSON.parse(value) as StorageValue<S>);
  const debouncedSetItem = new Debouncer(
    (name: string, value: StorageValue<S>) => {
      resolvedStorage.setItem(name, JSON.stringify(value));
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name) => {
      const value = resolvedStorage.getItem(name);
      return value instanceof Promise ? value.then(parse) : parse(value);
    },
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      resolvedStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}
