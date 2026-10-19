import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "./os-jank.ts";
import { ServerSettingsService } from "./serverSettings.ts";

/**
 * The second brain is a plain-Markdown folder: an AGENTS.md (or CLAUDE.md)
 * map at the root and one file per topic below it. Every provider reaches it
 * through the `brain_*` MCP tools, so Codex, Cursor, Grok and OpenCode get
 * the same knowledge Claude Code would load natively from CLAUDE.md.
 *
 * Every path an agent passes is relative to the root, must name a `.md`
 * file, and may not leave the root or enter a dot directory such as `.git`.
 */
export class SecondBrainError extends Schema.TaggedError<SecondBrainError>()("SecondBrainError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

const MAP_FILES = ["AGENTS.md", "CLAUDE.md", "README.md"] as const;
const MAX_FILES = 5000;
const MAX_SEARCH_BYTES = 1024 * 1024;
const MAX_MATCH_TEXT = 300;

export interface SecondBrainMap {
  readonly root: string;
  readonly mapFile: string | null;
  readonly map: string;
  readonly files: ReadonlyArray<string>;
}

export interface SecondBrainMatch {
  readonly path: string;
  readonly line?: number;
  readonly text: string;
}

const fail = (operation: string, message: string) =>
  Effect.fail(new SecondBrainError({ operation, message }));

/** The configured root, resolved to a real directory. */
export const resolveSecondBrainRoot = Effect.fn("secondBrain.resolveRoot")(function* () {
  const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
    Effect.mapError(
      () => new SecondBrainError({ operation: "configure", message: "Could not read settings." }),
    ),
  );
  const configured = settings.secondBrain.path;
  if (configured === "") {
    return yield* fail(
      "configure",
      "No second brain is configured. Set its folder in Settings → Research → Second brain.",
    );
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const expanded = path.resolve(yield* expandHomePath(configured));
  const root = yield* fs
    .realPath(expanded)
    .pipe(
      Effect.mapError(
        () =>
          new SecondBrainError({ operation: "configure", message: `${expanded} does not exist.` }),
      ),
    );
  const info = yield* fs.stat(root).pipe(Effect.orElseSucceed(() => undefined));
  if (info?.type !== "Directory") {
    return yield* fail("configure", `${expanded} is not a directory.`);
  }
  return root;
});

/** Checks an agent-supplied relative path and returns its absolute location. */
const locate = Effect.fn("secondBrain.locate")(function* (
  root: string,
  relative: string,
  operation: string,
) {
  const path = yield* Path.Path;
  const trimmed = relative.trim();
  if (trimmed === "" || path.isAbsolute(trimmed)) {
    return yield* fail(operation, "Pass a path relative to the second brain root.");
  }
  const absolute = path.resolve(root, trimmed);
  const inside = path.relative(root, absolute);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
    return yield* fail(operation, `${relative} is outside the second brain.`);
  }
  if (inside.split(path.sep).some((segment) => segment.startsWith("."))) {
    return yield* fail(operation, `${relative} is inside a hidden directory or names a dot file.`);
  }
  if (path.extname(inside).toLowerCase() !== ".md") {
    return yield* fail(operation, "Second brain files are Markdown: the path must end in .md.");
  }
  return { absolute, inside };
});

/** Rejects a location whose nearest existing ancestor resolves outside the root (a symlink). */
const ensureRealInside = Effect.fn("secondBrain.ensureRealInside")(function* (
  root: string,
  absolute: string,
  operation: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let probe = absolute;
  while (!(yield* fs.exists(probe).pipe(Effect.orElseSucceed(() => false)))) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const real = yield* fs.realPath(probe).pipe(Effect.orElseSucceed(() => probe));
  const inside = path.relative(root, real);
  if (inside.startsWith("..") || path.isAbsolute(inside)) {
    return yield* fail(operation, "That path resolves outside the second brain.");
  }
});

/** Every Markdown file below the root, relative and sorted, skipping dot directories. */
export const listSecondBrainFiles = Effect.fn("secondBrain.listFiles")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<string> = [];
  const walk = (directory: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const names = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
      for (const name of names.toSorted()) {
        if (files.length >= MAX_FILES) return;
        if (name.startsWith(".") || name === "node_modules") continue;
        const absolute = path.join(directory, name);
        const info = yield* fs.stat(absolute).pipe(Effect.orElseSucceed(() => undefined));
        if (info?.type === "Directory") {
          yield* walk(absolute);
        } else if (info?.type === "File" && name.toLowerCase().endsWith(".md")) {
          files.push(path.relative(root, absolute));
        }
      }
    });
  yield* walk(root);
  return files.toSorted();
});

/**
 * The map file with its `@file.md` lines inlined, as Claude Code does for
 * CLAUDE.md, plus the file list, so any provider starts with the same view.
 */
export const readSecondBrainMap = Effect.fn("secondBrain.readMap")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = yield* listSecondBrainFiles(root);
  let mapFile: string | null = null;
  let map = "";
  for (const candidate of MAP_FILES) {
    const text = yield* fs
      .readFileString(path.join(root, candidate))
      .pipe(Effect.orElseSucceed(() => undefined));
    if (text === undefined) continue;
    // A CLAUDE.md that only imports AGENTS.md is handled by inlining below.
    mapFile = candidate;
    map = text;
    break;
  }
  const lines: Array<string> = [];
  for (const line of map.split("\n")) {
    const reference = /^@(\S+\.md)\s*$/i.exec(line.trim())?.[1];
    if (reference === undefined) {
      lines.push(line);
      continue;
    }
    const located = yield* locate(root, reference, "map").pipe(Effect.option);
    const text =
      located._tag === "Some"
        ? yield* fs
            .readFileString(located.value.absolute)
            .pipe(Effect.orElseSucceed(() => undefined))
        : undefined;
    lines.push(text === undefined ? line : `<!-- ${reference} -->\n${text.trimEnd()}`);
  }
  return { root, mapFile, map: lines.join("\n"), files } satisfies SecondBrainMap;
});

export const readSecondBrainFile = Effect.fn("secondBrain.readFile")(function* (
  root: string,
  relative: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const { absolute, inside } = yield* locate(root, relative, "read");
  yield* ensureRealInside(root, absolute, "read");
  const content = yield* fs.readFileString(absolute).pipe(
    Effect.mapError(
      () =>
        new SecondBrainError({
          operation: "read",
          message: `${inside} does not exist. Call brain_map to see the files.`,
        }),
    ),
  );
  return { path: inside, content };
});

/**
 * Case-insensitive substring search. File-name hits come first, then line
 * hits in file order. Scanned per call: the folder changes behind the app.
 */
export const searchSecondBrain = Effect.fn("secondBrain.search")(function* (
  root: string,
  query: string,
  limit: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  const files = yield* listSecondBrainFiles(root);
  const nameHits: Array<SecondBrainMatch> = files
    .filter((file) => file.toLowerCase().includes(needle))
    .map((file) => ({ path: file, text: "(file name matches)" }));
  const lineHits: Array<SecondBrainMatch> = [];
  for (const file of files) {
    if (nameHits.length + lineHits.length >= limit) break;
    const absolute = path.join(root, file);
    const info = yield* fs.stat(absolute).pipe(Effect.orElseSucceed(() => undefined));
    if (info === undefined || Number(info.size) > MAX_SEARCH_BYTES) continue;
    const text = yield* fs.readFileString(absolute).pipe(Effect.orElseSucceed(() => ""));
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.toLowerCase().includes(needle)) continue;
      lineHits.push({ path: file, line: index + 1, text: line.trim().slice(0, MAX_MATCH_TEXT) });
      if (nameHits.length + lineHits.length >= limit) break;
    }
  }
  return [...nameHits, ...lineHits].slice(0, limit);
});

/** Replaces or appends to one Markdown file, creating folders as needed. Writes atomically. */
export const writeSecondBrainFile = Effect.fn("secondBrain.writeFile")(function* (
  root: string,
  relative: string,
  content: string,
  mode: "replace" | "append",
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { absolute, inside } = yield* locate(root, relative, "write");
  yield* ensureRealInside(root, absolute, "write");
  const writeFailed = (cause: unknown) =>
    new SecondBrainError({
      operation: "write",
      message: `Could not write ${inside}: ${String(cause)}`,
    });
  const existing = yield* fs.readFileString(absolute).pipe(Effect.orElseSucceed(() => undefined));
  const next =
    mode === "append" && existing !== undefined && existing !== ""
      ? `${existing.endsWith("\n") ? existing : `${existing}\n`}${content}`
      : content;
  const body = next.endsWith("\n") ? next : `${next}\n`;
  yield* fs
    .makeDirectory(path.dirname(absolute), { recursive: true })
    .pipe(Effect.mapError(writeFailed));
  const temporary = `${absolute}.${process.pid}.${yield* Clock.currentTimeMillis}.tmp`;
  yield* fs.writeFileString(temporary, body).pipe(Effect.mapError(writeFailed));
  yield* fs.rename(temporary, absolute).pipe(
    Effect.tapError(() => fs.remove(temporary).pipe(Effect.ignore)),
    Effect.mapError(writeFailed),
  );
  return { path: inside, created: existing === undefined, bytes: Buffer.byteLength(body) };
});
