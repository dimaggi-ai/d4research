// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

// Converts the stored structured-patch document behind a `toolCall` item's
// `patchRef` (fetched via `item/readOutput`, mediaType `application/json`)
// into a unified diff string for `turn.diff.updated` events.
//
// Observed body shape from `muse serve` 1.3.0:
//   {"files":[{"hunks":[{"lines":["-old","+new"],"newLines":1,"newStart":1,
//                        "oldLines":1,"oldStart":1}],
//              "path":"/abs/workspace/notes.txt"}]}
// `path` is absolute; hunk line entries carry their `-`/`+`/` ` prefix.
// The schema names no other fields, so everything beyond files/hunks/lines
// is read defensively and anything unparsable yields undefined.
interface PatchHunk {
  readonly lines: ReadonlyArray<string>;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

interface PatchFile {
  readonly oldPath: string;
  readonly newPath: string;
  readonly hunks: ReadonlyArray<PatchHunk>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asStringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

const countPrefixed = (lines: ReadonlyArray<string>, prefix: string): number =>
  lines.filter((line) => line.startsWith(prefix)).length;

const readHunk = (value: unknown): PatchHunk | undefined => {
  if (!isRecord(value)) return undefined;
  const lines = asStringArray(value.lines);
  if (lines.length === 0) return undefined;
  const oldLines = typeof value.oldLines === "number" ? value.oldLines : countPrefixed(lines, "-");
  const newLines = typeof value.newLines === "number" ? value.newLines : countPrefixed(lines, "+");
  const oldStart = typeof value.oldStart === "number" ? value.oldStart : 1;
  const newStart = typeof value.newStart === "number" ? value.newStart : 1;
  return { lines, oldStart, oldLines, newStart, newLines };
};

const readFile = (value: unknown): PatchFile | undefined => {
  if (!isRecord(value)) return undefined;
  const path = typeof value.path === "string" ? value.path : undefined;
  const oldPath = typeof value.oldPath === "string" ? value.oldPath : (path ?? undefined);
  const newPath = typeof value.newPath === "string" ? value.newPath : (path ?? undefined);
  if (oldPath === undefined && newPath === undefined) return undefined;
  const hunks = Array.isArray(value.hunks)
    ? value.hunks.flatMap((hunk) => {
        const parsed = readHunk(hunk);
        return parsed ? [parsed] : [];
      })
    : [];
  return { oldPath: oldPath ?? newPath!, newPath: newPath ?? oldPath!, hunks };
};

// Workspace-relative display path for diff headers. Absolute paths under the
// session cwd become relative; anything else passes through unchanged.
const displayPath = (path: string, cwd: string): string => {
  if (!NodePath.isAbsolute(path)) return path;
  const relative = NodePath.relative(cwd, path);
  return relative === "" || relative.startsWith("..") ? path : relative;
};

export function patchBodyToUnifiedDiff(body: unknown, cwd: string): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.files)) return undefined;
  const blocks: Array<string> = [];
  for (const entry of body.files) {
    const file = readFile(entry);
    if (!file) continue;
    const oldLines = file.hunks.reduce((sum, hunk) => sum + hunk.oldLines, 0);
    const newLines = file.hunks.reduce((sum, hunk) => sum + hunk.newLines, 0);
    const renamed = file.oldPath !== file.newPath;
    // A rename is represented by the old/new header pair even when no hunk
    // lines survived; content-only entries still need at least one hunk.
    if (file.hunks.length === 0 && !renamed) continue;
    const oldHeader =
      oldLines === 0 && !renamed ? "/dev/null" : `a/${displayPath(file.oldPath, cwd)}`;
    const newHeader =
      newLines === 0 && !renamed ? "/dev/null" : `b/${displayPath(file.newPath, cwd)}`;
    const out = [`--- ${oldHeader}`, `+++ ${newHeader}`];
    for (const hunk of file.hunks)
      out.push(
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        ...hunk.lines,
      );
    blocks.push(out.join("\n"));
  }
  return blocks.length > 0 ? blocks.join("\n") : undefined;
}
