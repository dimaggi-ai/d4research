// @effect-diagnostics nodeBuiltinImport:off -- The Promise-based tool loop awaits each write before it calls the tool.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { NiaMessage } from "./nia.ts";

type StoredMessage = Exclude<NiaMessage, { role: "system" }>;

export interface NiaJournal {
  readonly read: (providerThreadId: string) => Promise<ReadonlyArray<StoredMessage> | undefined>;
  readonly write: (
    providerThreadId: string,
    history: ReadonlyArray<StoredMessage>,
  ) => Promise<void>;
}

// Server events reach storage asynchronously, so a tool could run before its history is durable.
// The loop writes this file before every tool call and restores from it after a crash.
export const makeNiaJournal = (stateDir: string): NiaJournal => {
  const directory = NodePath.join(stateDir, "deepseek-nia");
  const file = (providerThreadId: string) =>
    NodePath.join(
      directory,
      `${NodeCrypto.createHash("sha256").update(providerThreadId).digest("hex")}.json`,
    );
  // Serialized per thread so an older snapshot can never be renamed over a newer one.
  const chains = new Map<string, Promise<void>>();
  const persist = async (providerThreadId: string, history: ReadonlyArray<StoredMessage>) => {
    await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    const target = file(providerThreadId);
    const temporary = `${target}.${NodeCrypto.randomUUID()}.tmp`;
    const handle = await NodeFSP.open(temporary, "w", 0o600);
    try {
      await handle.writeFile(JSON.stringify({ providerThreadId, history }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await NodeFSP.rename(temporary, target);
    const directoryHandle = await NodeFSP.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  };
  return {
    read: async (providerThreadId) => {
      let raw: string;
      try {
        raw = await NodeFSP.readFile(file(providerThreadId), "utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw cause;
      }
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("providerThreadId" in parsed) ||
        parsed.providerThreadId !== providerThreadId ||
        !("history" in parsed) ||
        !Array.isArray(parsed.history)
      )
        return undefined;
      return parsed.history as ReadonlyArray<StoredMessage>;
    },
    write: (providerThreadId, history) => {
      const next = (chains.get(providerThreadId) ?? Promise.resolve())
        .catch(() => {})
        .then(() => persist(providerThreadId, history));
      chains.set(providerThreadId, next);
      return next;
    },
  };
};

/** The journal wins only when it extends the committed history, e.g. after a crash mid-turn. */
export const preferJournal = (
  committed: ReadonlyArray<NiaMessage>,
  journal: ReadonlyArray<NiaMessage> | undefined,
): ReadonlyArray<NiaMessage> => {
  if (!journal || journal.length <= committed.length) return committed;
  const prefix = committed.every(
    (message, index) => canonical(message) === canonical(journal[index]),
  );
  return prefix ? journal : committed;
};

// Decoded thread metadata and parsed JSON can order keys differently.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, nested: unknown) =>
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(Object.entries(nested).toSorted(([a], [b]) => a.localeCompare(b)))
      : nested,
  );
