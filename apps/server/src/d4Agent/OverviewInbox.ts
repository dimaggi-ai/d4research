import type { D4BrainContext } from "@d4research/contracts";
import * as HostProcess from "@d4research/shared/HostProcess";
import { sha256Hex } from "@d4research/shared/hash";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const isoDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
  Schema.makeFilter((value: string) => Number.isFinite(Date.parse(value))),
);
export const OverviewItem = Schema.Struct({
  key: Schema.String.check(Schema.isMinLength(1)),
  severity: Schema.Literals(["info", "attention", "critical"]),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  body: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  recommendation: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
  ref: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  expiresAt: Schema.optionalKey(isoDate),
});
export type OverviewItem = typeof OverviewItem.Type;
const Snapshot = Schema.Struct({
  version: Schema.Literal(1),
  source: Schema.String.check(Schema.isMinLength(1)),
  generatedAt: isoDate,
  items: Schema.Array(OverviewItem).check(Schema.isMaxLength(200)),
});
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(Snapshot));
export interface OverviewSnapshot {
  readonly source: string;
  readonly context: D4BrainContext;
  readonly items: ReadonlyArray<OverviewItem>;
}
const maxBytes = 256 * 1024;
const internalSources = new Set(["threads", "scheduled", "system", "cto"]);
const clean = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\[\[|\]\]/g, "");
function sanitize(item: OverviewItem): OverviewItem {
  return {
    ...item,
    key: clean(item.key),
    title: clean(item.title),
    ...(item.body === undefined ? {} : { body: clean(item.body) }),
    ...(item.recommendation === undefined ? {} : { recommendation: clean(item.recommendation) }),
    ...(item.ref === undefined ? {} : { ref: clean(item.ref) }),
  };
}
function diagnostic(source: string, reason: "invalid" | "unmapped"): OverviewItem {
  return {
    key: `overview-source:${sha256Hex(source)}:${reason}`,
    severity: "attention",
    title: `overview source ${clean(source).slice(0, 150)} ${reason}`,
  };
}

export const InboxDirectory = Context.Reference<string | undefined>(
  "d4research/d4Agent/OverviewInbox/Directory",
  { defaultValue: () => undefined },
);
export class OverviewInbox extends Context.Service<
  OverviewInbox,
  {
    readonly read: (mappings: Readonly<Record<string, D4BrainContext>>) => Effect.Effect<{
      readonly snapshots: ReadonlyArray<OverviewSnapshot>;
      readonly diagnostics: ReadonlyArray<OverviewItem>;
    }>;
  }
>()("d4research/d4Agent/OverviewInbox") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory =
    (yield* InboxDirectory) ??
    path.join(yield* HostProcess.HomeDirectory, ".local/state/nia-inbox");
  const read = Effect.fn("OverviewInbox.read")(function* (
    mappings: Readonly<Record<string, D4BrainContext>>,
  ) {
    const snapshots: OverviewSnapshot[] = [];
    const diagnostics: OverviewItem[] = [];
    const names = yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 }).pipe(
      Effect.andThen(fs.readDirectory(directory)),
      Effect.timeout("3 seconds"),
      Effect.catch(() => Effect.succeed(null)),
    );
    if (names === null) return { snapshots, diagnostics: [diagnostic("inbox", "invalid")] };
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const source = name.slice(0, -5);
      const context = Object.hasOwn(mappings, source) ? mappings[source] : undefined;
      if (context === undefined) {
        diagnostics.push(diagnostic(source, "unmapped"));
        continue;
      }
      if (internalSources.has(source)) {
        diagnostics.push(diagnostic(source, "invalid"));
        continue;
      }
      const snapshot = yield* fs
        .stream(path.join(directory, name), { bytesToRead: maxBytes + 1 })
        .pipe(
          Stream.runCollect,
          Effect.flatMap((chunks) => {
            const bytes = Buffer.concat(chunks);
            if (bytes.length > maxBytes) return Effect.succeed(null);
            return decodeSnapshot(bytes.toString("utf8"));
          }),
          Effect.timeout("3 seconds"),
          Effect.catch(() => Effect.succeed(null)),
        );
      if (snapshot === null || snapshot.source !== source) {
        diagnostics.push(diagnostic(source, "invalid"));
        continue;
      }
      const items = snapshot.items.map(sanitize);
      if (
        items.some((item) => item.key.length === 0 || item.title.trim().length === 0) ||
        new Set(items.map((item) => item.key)).size !== items.length
      ) {
        diagnostics.push(diagnostic(source, "invalid"));
        continue;
      }
      snapshots.push({ source, context, items });
    }
    return { snapshots, diagnostics };
  });
  return OverviewInbox.of({ read });
});

export const layer = Layer.effect(OverviewInbox, make);
