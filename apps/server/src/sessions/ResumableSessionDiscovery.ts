import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  ListResumableSessionsError,
  ProviderDriverKind,
  ProviderInstanceId,
  RESUMABLE_SESSIONS_MAX_LIMIT,
  type ListResumableSessionsResult,
  type ResumableSession,
} from "@d4research/contracts";

import { ServerSettingsService } from "../serverSettings.ts";

const CLAUDE_DRIVER = "claudeAgent";
const CODEX_DRIVER = "codex";
// A session whose file changed within this window is shown as "active" (best-effort liveness — the
// CLIs do not persist a definitive running/awaiting/completed flag we can read).
const ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const MAX_CLAUDE_FILES_PER_DIR = 60;
const MAX_CODEX_FILES = 80;
const TITLE_MAX = 140;
const PARSE_MAX_BYTES = 2_000_000;

export interface ResumableSessionDiscoveryShape {
  readonly list: (input: {
    readonly cwd: string;
    readonly now?: number;
  }) => Effect.Effect<ListResumableSessionsResult, ListResumableSessionsError>;
}

export class ResumableSessionDiscovery extends Context.Service<
  ResumableSessionDiscovery,
  ResumableSessionDiscoveryShape
>()("t3/sessions/ResumableSessionDiscovery") {}

function expandHome(raw: string): string {
  const home = NodeOS.homedir();
  const trimmed = raw.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return `${home}/${trimmed.slice(2)}`;
  return trimmed;
}

/** Claude Code stores a project's sessions under `projects/<cwd with non-alphanumerics as ->`. */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function truncateTitle(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > TITLE_MAX ? `${collapsed.slice(0, TITLE_MAX - 1)}…` : collapsed;
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (part !== null && typeof part === "object") {
      const record = part as Record<string, unknown>;
      const type = record.type;
      if ((type === "text" || type === "input_text") && typeof record.text === "string") {
        return record.text;
      }
    }
  }
  return null;
}

// A user prompt worth showing as a title: real text, not a tool result, command wrapper, or system
// scaffolding the agents inject before the first human message.
function isMeaningfulUserText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("<")) return false;
  if (trimmed.startsWith("Caveat:")) return false;
  return true;
}

interface ParsedClaudeSession {
  readonly title: string | null;
  readonly messageCount: number;
  readonly lastTimestamp: string | null;
  readonly model: string | null;
}

export function parseClaudeSession(contents: string): ParsedClaudeSession {
  let title: string | null = null;
  let messageCount = 0;
  let lastTimestamp: string | null = null;
  let summaryFallback: string | null = null;
  let model: string | null = null;
  for (const line of contents.split("\n")) {
    const entry = parseJsonLine(line);
    if (!entry) continue;
    const type = entry.type;
    if (typeof entry.timestamp === "string") lastTimestamp = entry.timestamp;
    if (type === "summary" && typeof entry.summary === "string" && summaryFallback === null) {
      summaryFallback = entry.summary;
    }
    if (type === "user" || type === "assistant") {
      messageCount += 1;
      const message = entry.message;
      if (message !== null && typeof message === "object") {
        const record = message as Record<string, unknown>;
        if (type === "assistant" && typeof record.model === "string" && record.model.length > 0) {
          model = record.model;
        }
        if (title === null && type === "user") {
          const text = textFromContent(record.content);
          if (text !== null && isMeaningfulUserText(text)) title = text;
        }
      }
    }
  }
  return { title: title ?? summaryFallback, messageCount, lastTimestamp, model };
}

interface ParsedCodexSession {
  readonly id: string | null;
  readonly cwd: string | null;
  readonly headerTimestamp: string | null;
  readonly title: string | null;
  readonly messageCount: number;
  readonly model: string | null;
}

export function parseCodexSession(contents: string): ParsedCodexSession {
  let id: string | null = null;
  let cwd: string | null = null;
  let headerTimestamp: string | null = null;
  let title: string | null = null;
  let messageCount = 0;
  let model: string | null = null;
  const lines = contents.split("\n");
  const header = parseJsonLine(lines[0] ?? "");
  if (header) {
    if (
      header.type === "session_meta" &&
      header.payload !== null &&
      typeof header.payload === "object"
    ) {
      const payload = header.payload as Record<string, unknown>;
      if (typeof payload.id === "string") id = payload.id;
      if (typeof payload.cwd === "string") cwd = payload.cwd;
      if (typeof payload.timestamp === "string") headerTimestamp = payload.timestamp;
      if (typeof payload.model === "string" && payload.model.length > 0) model = payload.model;
    } else {
      // Legacy rollout header: `{ id, timestamp, git }` without a cwd we can match on.
      if (typeof header.id === "string") id = header.id;
      if (typeof header.timestamp === "string") headerTimestamp = header.timestamp;
      if (typeof header.cwd === "string") cwd = header.cwd;
    }
  }
  for (const line of lines) {
    const entry = parseJsonLine(line);
    if (!entry || entry.type !== "response_item") continue;
    const payload = entry.payload;
    if (payload === null || typeof payload !== "object") continue;
    const record = payload as Record<string, unknown>;
    if (record.type !== "message") continue;
    const role = record.role;
    if (role === "user" || role === "assistant") messageCount += 1;
    if (title === null && role === "user") {
      const text = textFromContent(record.content);
      if (text !== null && isMeaningfulUserText(text)) title = text;
    }
  }
  return { id, cwd, headerTimestamp, title, messageCount, model };
}

function isoFromMillis(millis: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(millis));
}

function statusFromMtime(mtimeMs: number, now: number): ResumableSession["status"] {
  return now - mtimeMs <= ACTIVE_WINDOW_MS ? "active" : "idle";
}

const make: Effect.Effect<
  ResumableSessionDiscoveryShape,
  never,
  ServerSettingsService | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const readBoundedFile = (filePath: string): Effect.Effect<string | null, never, never> =>
    fs.readFileString(filePath).pipe(
      Effect.map((contents) =>
        contents.length > PARSE_MAX_BYTES ? contents.slice(0, PARSE_MAX_BYTES) : contents,
      ),
      Effect.orElseSucceed(() => null),
    );

  const statMtimeMs = (filePath: string): Effect.Effect<number | null, never, never> =>
    fs.stat(filePath).pipe(
      Effect.map((info) => {
        const mtime = info.mtime;
        return mtime._tag === "Some" ? mtime.value.getTime() : null;
      }),
      Effect.orElseSucceed(() => null),
    );

  // Configured Claude instances → their config dirs + labels. Always includes the default store.
  const resolveClaudeStores = Effect.fn("resolveClaudeStores")(function* () {
    const stores = new Map<string, { instanceId: string; label: string }>();
    const add = (dir: string, instanceId: string, label: string) => {
      const resolved = path.resolve(expandHome(dir));
      if (!stores.has(resolved)) stores.set(resolved, { instanceId, label });
    };
    const envConfigDir = process.env.CLAUDE_CONFIG_DIR;
    add(
      envConfigDir && envConfigDir.trim().length > 0
        ? envConfigDir
        : path.join(NodeOS.homedir(), ".claude"),
      CLAUDE_DRIVER,
      "Claude",
    );
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings) {
      for (const [instanceId, instance] of Object.entries(settings.providerInstances)) {
        if (instance.driver !== CLAUDE_DRIVER) continue;
        const label = instance.displayName ?? "Claude";
        const config = instance.config;
        const configDir =
          config !== null && typeof config === "object"
            ? (config as Record<string, unknown>).configDir
            : undefined;
        if (typeof configDir === "string" && configDir.trim().length > 0) {
          add(configDir, instanceId, label);
        } else {
          // Instance using the default store: relabel the default entry with its display name.
          const defaultDir = path.resolve(
            envConfigDir && envConfigDir.trim().length > 0
              ? envConfigDir
              : path.join(NodeOS.homedir(), ".claude"),
          );
          const existing = stores.get(defaultDir);
          if (existing && existing.instanceId === CLAUDE_DRIVER) {
            stores.set(defaultDir, { instanceId, label });
          }
        }
      }
    }
    return stores;
  });

  const listClaudeSessions = Effect.fn("listClaudeSessions")(function* (cwd: string, now: number) {
    const stores = yield* resolveClaudeStores();
    const sessions: ResumableSession[] = [];
    const encoded = encodeClaudeProjectDir(cwd);
    for (const [storeDir, { instanceId, label }] of stores) {
      const projectDir = path.join(storeDir, "projects", encoded);
      const exists = yield* fs.exists(projectDir).pipe(Effect.orElseSucceed(() => false));
      if (!exists) continue;
      const names = yield* fs.readDirectory(projectDir).pipe(Effect.orElseSucceed(() => []));
      const jsonl = names.filter((name) => name.endsWith(".jsonl"));
      const withMtime: Array<{ name: string; mtimeMs: number }> = [];
      for (const name of jsonl) {
        const mtimeMs = yield* statMtimeMs(path.join(projectDir, name));
        withMtime.push({ name, mtimeMs: mtimeMs ?? 0 });
      }
      withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (const { name, mtimeMs } of withMtime.slice(0, MAX_CLAUDE_FILES_PER_DIR)) {
        const filePath = path.join(projectDir, name);
        const contents = yield* readBoundedFile(filePath);
        if (contents === null) continue;
        const sessionId = name.replace(/\.jsonl$/, "");
        const parsed = parseClaudeSession(contents);
        if (parsed.messageCount === 0) continue;
        const updatedAtMs = parsed.lastTimestamp ? Date.parse(parsed.lastTimestamp) : mtimeMs;
        const updatedAt = Number.isFinite(updatedAtMs)
          ? isoFromMillis(updatedAtMs)
          : isoFromMillis(mtimeMs);
        sessions.push({
          key: `${instanceId}:${sessionId}`,
          provider: ProviderDriverKind.make(CLAUDE_DRIVER),
          providerInstanceId: ProviderInstanceId.make(instanceId),
          providerLabel: label,
          sessionId,
          resumeCursor: sessionId,
          model: parsed.model,
          title: truncateTitle(parsed.title ?? "Untitled session"),
          updatedAt,
          messageCount: parsed.messageCount,
          status: statusFromMtime(mtimeMs, now),
        });
      }
    }
    return sessions;
  });

  // Walk `<codexHome>/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl` newest-first, bounded.
  const collectRecentCodexFiles = Effect.fn("collectRecentCodexFiles")(function* (
    sessionsRoot: string,
  ) {
    const files: string[] = [];
    const listSortedDesc = (dir: string) =>
      fs.readDirectory(dir).pipe(
        Effect.map((names) =>
          names.filter((name) => !name.startsWith(".")).sort((a, b) => b.localeCompare(a)),
        ),
        Effect.orElseSucceed(() => [] as string[]),
      );
    const years = yield* listSortedDesc(sessionsRoot);
    for (const year of years) {
      if (files.length >= MAX_CODEX_FILES) break;
      const months = yield* listSortedDesc(path.join(sessionsRoot, year));
      for (const month of months) {
        if (files.length >= MAX_CODEX_FILES) break;
        const days = yield* listSortedDesc(path.join(sessionsRoot, year, month));
        for (const day of days) {
          if (files.length >= MAX_CODEX_FILES) break;
          const dayDir = path.join(sessionsRoot, year, month, day);
          const names = yield* listSortedDesc(dayDir);
          for (const name of names) {
            if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
            files.push(path.join(dayDir, name));
            if (files.length >= MAX_CODEX_FILES) break;
          }
        }
      }
    }
    return files;
  });

  const listCodexSessions = Effect.fn("listCodexSessions")(function* (cwd: string, now: number) {
    const codexHomeRaw = process.env.CODEX_HOME;
    const codexHome =
      codexHomeRaw && codexHomeRaw.trim().length > 0
        ? path.resolve(expandHome(codexHomeRaw))
        : path.join(NodeOS.homedir(), ".codex");
    const sessionsRoot = path.join(codexHome, "sessions");
    const rootExists = yield* fs.exists(sessionsRoot).pipe(Effect.orElseSucceed(() => false));
    if (!rootExists) return [];
    const targetCwd = path.resolve(cwd);
    const files = yield* collectRecentCodexFiles(sessionsRoot);
    const sessions: ResumableSession[] = [];
    for (const filePath of files) {
      const contents = yield* readBoundedFile(filePath);
      if (contents === null) continue;
      const parsed = parseCodexSession(contents);
      if (!parsed.id || !parsed.cwd) continue;
      if (path.resolve(parsed.cwd) !== targetCwd) continue;
      if (parsed.messageCount === 0) continue;
      const mtimeMs = (yield* statMtimeMs(filePath)) ?? 0;
      const updatedAtMs = parsed.headerTimestamp ? Date.parse(parsed.headerTimestamp) : mtimeMs;
      const updatedAt = Number.isFinite(updatedAtMs)
        ? isoFromMillis(updatedAtMs)
        : isoFromMillis(mtimeMs);
      sessions.push({
        key: `${CODEX_DRIVER}:${parsed.id}`,
        provider: ProviderDriverKind.make(CODEX_DRIVER),
        providerInstanceId: ProviderInstanceId.make(CODEX_DRIVER),
        providerLabel: "Codex",
        sessionId: parsed.id,
        resumeCursor: { threadId: parsed.id },
        model: parsed.model,
        title: truncateTitle(parsed.title ?? "Untitled session"),
        updatedAt,
        messageCount: parsed.messageCount,
        status: statusFromMtime(mtimeMs, now),
      });
    }
    return sessions;
  });

  const list: ResumableSessionDiscoveryShape["list"] = Effect.fn("ResumableSessionDiscovery.list")(
    function* (input) {
      const now = input.now ?? (yield* Clock.currentTimeMillis);
      const cwd = input.cwd;
      const [claude, codex] = yield* Effect.all(
        [
          listClaudeSessions(cwd, now).pipe(Effect.orElseSucceed(() => [] as ResumableSession[])),
          listCodexSessions(cwd, now).pipe(Effect.orElseSucceed(() => [] as ResumableSession[])),
        ],
        { concurrency: 2 },
      );
      const merged = [...claude, ...codex].sort(
        (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      );
      const truncated = merged.length > RESUMABLE_SESSIONS_MAX_LIMIT;
      return {
        sessions: truncated ? merged.slice(0, RESUMABLE_SESSIONS_MAX_LIMIT) : merged,
        truncated,
      };
    },
  );

  return ResumableSessionDiscovery.of({ list });
});

export const layer = Layer.effect(ResumableSessionDiscovery, make);
