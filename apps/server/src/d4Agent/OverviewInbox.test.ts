import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Inbox from "./OverviewInbox.ts";

const item = { key: "message-1", severity: "attention" as const, title: "Review needed" };
const snapshot = (changes: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    source: "mail",
    generatedAt: "2026-10-26T10:00:00Z",
    items: [item],
    ...changes,
  });
function testLayer(files: Record<string, string>) {
  return Inbox.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Inbox.InboxDirectory, "/inbox"),
        Path.layer,
        FileSystem.layerNoop({
          makeDirectory: (path, options) =>
            Effect.sync(() => {
              assert.equal(path, "/inbox");
              assert.equal(options?.mode, 0o700);
            }),
          readDirectory: () => Effect.succeed(Object.keys(files)),
          stream: (path, options) => {
            assert.equal(options?.bytesToRead, 256 * 1024 + 1);
            return Stream.make(
              Buffer.from(files[path.slice("/inbox/".length)]!).subarray(0, 256 * 1024 + 1),
            );
          },
        }),
      ),
    ),
  );
}

describe("OverviewInbox", () => {
  it.effect("takes context only from settings and strips controls and thread markup", () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.OverviewInbox;
      const result = yield* inbox.read({ mail: "Personal" });
      assert.deepEqual(result, {
        snapshots: [
          {
            source: "mail",
            context: "Personal",
            items: [
              {
                ...item,
                title: "thread:private|Secret",
                body: "message",
                recommendation: "Read",
                ref: "link",
              },
            ],
          },
        ],
        diagnostics: [],
      });
    }).pipe(
      Effect.provide(
        testLayer({
          "mail.json": snapshot({
            context: "Global",
            items: [
              {
                ...item,
                title: "[[thread:private|Secret]]\u0000",
                body: "mes\nsage",
                recommendation: "[[Read]]",
                ref: "li\u001bnk",
              },
            ],
          }),
        }),
      ),
    ),
  );

  it.effect.each(
    Object.entries({
      "invalid JSON": "{",
      "wrong version": snapshot({ version: 2 }),
      "wrong source": snapshot({ source: "other" }),
      "invalid timestamp": snapshot({ generatedAt: "yesterday" }),
      "invalid expiry": snapshot({ items: [{ ...item, expiresAt: "later" }] }),
      "too many items": snapshot({
        items: Array.from({ length: 201 }, (_, i) => ({ ...item, key: `${i}` })),
      }),
      "long title": snapshot({ items: [{ ...item, title: "a".repeat(201) }] }),
      "long body": snapshot({ items: [{ ...item, body: "a".repeat(501) }] }),
      "long recommendation": snapshot({ items: [{ ...item, recommendation: "a".repeat(501) }] }),
      "long ref": snapshot({ items: [{ ...item, ref: "a".repeat(301) }] }),
      "duplicate keys": snapshot({ items: [item, item] }),
      "empty sanitized key": snapshot({ items: [{ ...item, key: "[[\u0000]]" }] }),
      "oversized file": snapshot({ unused: "a".repeat(256 * 1024) }),
    }),
  )("ignores %s with a stable, content-free diagnostic", ([, content]) =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.OverviewInbox;
      const first = yield* inbox.read({ mail: "Personal" });
      const second = yield* inbox.read({ mail: "Personal" });
      assert.deepEqual(first, second);
      assert.deepEqual(first.snapshots, []);
      assert.equal(first.diagnostics.length, 1);
      assert.equal(first.diagnostics[0]?.title, "overview source mail invalid");
      assert.equal(first.diagnostics[0]?.severity, "attention");
    }).pipe(Effect.provide(testLayer({ "mail.json": content }))),
  );

  it.effect(
    "reports unmapped sources without exposing item content and ignores temporary files",
    () =>
      Effect.gen(function* () {
        const inbox = yield* Inbox.OverviewInbox;
        const result = yield* inbox.read({});
        assert.deepEqual(result.snapshots, []);
        assert.equal(result.diagnostics.length, 1);
        assert.equal(result.diagnostics[0]?.title, "overview source mail unmapped");
        assert.isFalse(JSON.stringify(result).includes("Review needed"));
      }).pipe(Effect.provide(testLayer({ "mail.json": snapshot(), "mail.json.tmp": "{" }))),
  );

  it.effect("does not trust inherited context mappings", () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.OverviewInbox;
      const result = yield* inbox.read({});
      assert.deepEqual(result.snapshots, []);
      assert.equal(result.diagnostics[0]?.title, "overview source constructor unmapped");
    }).pipe(Effect.provide(testLayer({ "constructor.json": snapshot({ source: "constructor" }) }))),
  );

  it.effect("rejects producers that claim reserved internal sources", () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.OverviewInbox;
      const result = yield* inbox.read({ system: "Global" });
      assert.deepEqual(result.snapshots, []);
      assert.equal(result.diagnostics[0]?.title, "overview source system invalid");
    }).pipe(Effect.provide(testLayer({ "system.json": snapshot({ source: "system" }) }))),
  );

  it.effect("accepts empty snapshots so removed items can resolve", () =>
    Effect.gen(function* () {
      const inbox = yield* Inbox.OverviewInbox;
      assert.deepEqual(yield* inbox.read({ mail: "Personal" }), {
        snapshots: [{ source: "mail", context: "Personal", items: [] }],
        diagnostics: [],
      });
    }).pipe(Effect.provide(testLayer({ "mail.json": snapshot({ items: [] }) }))),
  );
});
