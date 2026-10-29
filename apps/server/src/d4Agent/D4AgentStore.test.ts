import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ChatAttachmentId, D4AgentSendInput, ThreadId } from "@d4research/contracts";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Config from "../config.ts";
import * as Store from "./D4AgentStore.ts";
const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(Store.StoredState));
it.effect(
  "store survives restart and makes interrupted approved actions require confirmation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-agent-store-" });
        const config = Config.layerTest(process.cwd(), directory);
        const acquire = Store.D4AgentStore.pipe(
          Effect.provide(Store.layer.pipe(Layer.provide(config))),
        );
        const first = yield* acquire;
        assert.equal((yield* first.get).threadId, null);
        yield* first.update((state) => ({
          ...state,
          threadId: ThreadId.make("persistent"),
          rotation: {
            threadId: ThreadId.make("persistent"),
            context: "Global",
            messageId: "summary",
            pendingText: "",
            requestedAt: "2026-10-24T00:00:00Z",
            pendingAttachments: [
              {
                type: "image",
                id: ChatAttachmentId.make("pending-image"),
                name: "screen.png",
                mimeType: "image/png",
                sizeBytes: 3,
              },
            ],
            pendingFollowUpBehavior: "queue",
          },
          actions: [
            {
              context: "Global",
              sessionId: null,
              id: "interrupted",
              action: { type: "interrupt", threadId: ThreadId.make("other") },
              status: "approved",
              createdAt: "2026-10-24T00:00:00Z",
              resolvedAt: null,
            },
          ],
        }));
        const reopened = yield* acquire;
        assert.equal((yield* reopened.get).threadId, "persistent");
        assert.equal((yield* reopened.get).actions[0]?.status, "pending");
        assert.deepEqual((yield* reopened.get).rotation, (yield* first.get).rotation);
        assert.equal((yield* reopened.get).rotation?.pendingAttachments?.[0]?.name, "screen.png");
        assert.equal(
          (yield* fs.stat(`${directory}/userdata/d4-agent/state.json`)).mode & 0o777,
          0o600,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
it.effect("corrupt and incompatible state is quarantined without failing startup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-agent-corrupt-" });
      const stateDirectory = `${directory}/userdata/d4-agent`;
      yield* fs.makeDirectory(stateDirectory, { recursive: true });
      for (const content of ["{broken", JSON.stringify({ threadId: 9 })]) {
        yield* fs.writeFileString(`${stateDirectory}/state.json`, content);
        const store = yield* Store.D4AgentStore.pipe(
          Effect.provide(
            Store.layer.pipe(Layer.provide(Config.layerTest(process.cwd(), directory))),
          ),
        );
        assert.equal((yield* store.get).threadId, null);
        assert.isFalse(yield* fs.exists(`${stateDirectory}/state.json`));
        const quarantined = (yield* fs.readDirectory(stateDirectory)).filter((name) =>
          name.startsWith("state.json.corrupt-"),
        );
        assert.isTrue(quarantined.length > 0);
        assert.isTrue(
          (yield* Effect.forEach(quarantined, (name) =>
            fs.readFileString(`${stateDirectory}/${name}`),
          )).includes(content),
        );
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "bounds persisted CTO previews by count and UTF-8 bytes without changing action metadata",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-agent-preview-" });
        const acquire = Store.D4AgentStore.pipe(
          Effect.provide(
            Store.layer.pipe(Layer.provide(Config.layerTest(process.cwd(), directory))),
          ),
        );
        const store = yield* acquire;
        const next = yield* store.update((state) => ({
          ...state,
          actions: Array.from({ length: 14 }, (_, index) => ({
            context: "Dimaggi" as const,
            sessionId: null,
            id: `cto-${index}`,
            action: {
              type: "cto-ask" as const,
              context: "Dimaggi" as const,
              text: `question ${index}`,
            },
            status: "executed" as const,
            createdAt: "2026-10-24T00:00:00Z",
            resolvedAt: "2026-10-24T00:01:00Z",
            result: "abc" + "😀".repeat(70000),
          })),
        }));
        const previews = next.actions.filter((action) => action.result !== undefined);
        assert.deepEqual(
          previews.map((action) => action.id),
          Array.from({ length: 10 }, (_, i) => `cto-${i + 4}`),
        );
        for (const action of previews) {
          assert.isString(action.result);
          assert.isAtMost(new TextEncoder().encode(String(action.result)).length, 4096);
        }
        assert.equal(next.actions.length, 14);
        assert.equal(next.actions[0]?.status, "executed");
        assert.equal(next.actions[0]?.action.type, "cto-ask");
        const persisted = decodeState(
          yield* fs.readFileString(`${directory}/userdata/d4-agent/state.json`),
        );
        assert.equal(persisted.actions.filter((action) => action.result !== undefined).length, 10);
        assert.deepEqual((yield* (yield* acquire).get).actions, next.actions);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "prunes bindings to the latest sixteen for the current thread and persists the bound set",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-agent-bindings-" });
        const acquire = Store.D4AgentStore.pipe(
          Effect.provide(
            Store.layer.pipe(Layer.provide(Config.layerTest(process.cwd(), directory))),
          ),
        );
        const store = yield* acquire;
        const current = ThreadId.make("current-thread");
        const next = yield* store.update((state) => ({
          ...state,
          threadId: current,
          bindings: Array.from({ length: 40 }, (_, i) => ({
            context: "YB" as const,
            threadId: i % 2 === 0 ? current : ThreadId.make(`retired-${i}`),
            sessionId: `session-${i}`,
          })),
        }));
        assert.equal(next.bindings.length, 16);
        assert.isTrue(next.bindings.every((binding) => binding.threadId === current));
        assert.deepEqual(
          next.bindings.map((binding) => binding.sessionId),
          Array.from({ length: 16 }, (_, i) => `session-${8 + i * 2}`),
        );
        assert.deepEqual((yield* (yield* acquire).get).bindings, next.bindings);
        const cleared = yield* store.update((state) => ({ ...state, threadId: null }));
        assert.deepEqual(cleared.bindings, []);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not rewrite state.json or replace its inode for an unchanged update", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-agent-unchanged-" });
      const store = yield* Store.D4AgentStore.pipe(
        Effect.provide(Store.layer.pipe(Layer.provide(Config.layerTest(process.cwd(), directory)))),
      );
      yield* store.update((state) => ({ ...state, heartbeatAt: 1 }));
      const path = `${directory}/userdata/d4-agent/state.json`;
      const before = yield* fs.stat(path);
      const bytes = yield* fs.readFileString(path);
      yield* store.update((state) => ({ ...state }));
      const after = yield* fs.stat(path);
      assert.deepEqual(after.ino, before.ino);
      assert.deepEqual(after.mtime, before.mtime);
      assert.equal(yield* fs.readFileString(path), bytes);
      assert.isFalse(yield* fs.exists(`${path}.tmp`));
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("restart marks an unfinished CTO ask failed without retrying", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-cto-restart-" });
      const acquire = Store.D4AgentStore.pipe(
        Effect.provide(Store.layer.pipe(Layer.provide(Config.layerTest(process.cwd(), directory)))),
      );
      const first = yield* acquire;
      yield* first.update((state) => ({
        ...state,
        actions: [
          {
            id: "interrupted-cto",
            context: "Dimaggi",
            sessionId: ThreadId.make("old-session"),
            action: { type: "cto-ask", context: "Dimaggi", text: "Synthetic question" },
            status: "executed",
            createdAt: "2026-10-24T00:00:00Z",
            resolvedAt: null,
            result: "Asked, answer will be posted.",
          },
        ],
      }));
      const reopened = yield* acquire;
      const record = (yield* reopened.get).actions[0]!;
      assert.equal(record.status, "failed");
      assert.equal(
        record.result,
        "CTO question interrupted by server restart; no automatic retry.",
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "bounds archive records by count and thirty-day age while preserving pending approvals",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-agent-archive-bounds-" });
        const store = yield* Store.D4AgentStore.pipe(
          Effect.provide(
            Store.layer.pipe(Layer.provide(Config.layerTest(process.cwd(), directory))),
          ),
        );
        const state = yield* store.update((value) => ({
          ...value,
          actions: Array.from({ length: 900 }, (_, index) => ({
            id: `archive:${index}`,
            context: "Global" as const,
            sessionId: null,
            action: { type: "auto-archive" as const, threadId: ThreadId.make(`task-${index}`) },
            status: "executed" as const,
            createdAt: index < 100 ? "1969-01-01T00:00:00.000Z" : "1970-01-01T00:00:00.000Z",
            resolvedAt: "1970-01-01T00:00:00.000Z",
          })),
        }));
        assert.equal(state.actions.length, 200);
        assert.equal(state.actions[0]?.id, "archive:700");
        yield* TestClock.adjust("31 days");
        assert.equal((yield* store.update((value) => value)).actions.length, 0);
        assert.isTrue(
          state.actions.every((entry) => entry.createdAt === "1970-01-01T00:00:00.000Z"),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it("send decoding accepts older clients and attachment-only input but rejects an empty turn", () => {
  const decode = Schema.decodeUnknownOption(D4AgentSendInput);
  assert.isTrue(
    Option.isSome(
      decode({ text: "Existing client", expectedContext: "Global", expectedThreadId: null }),
    ),
  );
  assert.isTrue(
    Option.isSome(
      decode({
        text: "",
        attachments: [
          {
            type: "image",
            id: "pending-image",
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
      }),
    ),
  );
  assert.isTrue(Option.isNone(decode({ text: "", attachments: [] })));
});

it.effect(
  "host routine metadata is bounded, validated, read-only and distinct from an unavailable snapshot",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "d4-host-routines-" });
        const stateDirectory = `${directory}/userdata/d4-agent`;
        const file = `${stateDirectory}/host-routines.json`;
        const store = yield* Store.D4AgentStore.pipe(
          Effect.provide(
            Store.layer.pipe(Layer.provide(Config.layerTest(process.cwd(), directory))),
          ),
        );
        assert.deepEqual(yield* store.readHostRoutines!(), {
          status: "not-configured",
          routines: [],
        });
        yield* fs.makeDirectory(stateDirectory, { recursive: true });
        const routine = {
          id: "host-public-check",
          title: "Public source check",
          context: "Personal",
          source: "systemd",
          schedule: "daily 09:00",
          timeZone: "UTC",
          enabled: true,
          nextRunAt: null,
          lastRunAt: null,
          lastRunStatus: "unknown",
          observedAt: "2026-10-28T10:00:00Z",
          capability: "read-only",
        } as const;
        yield* fs.writeFileString(
          file,
          JSON.stringify({
            routines: [
              {
                ...routine,
                command: "PRIVATE COMMAND",
                prompt: "PRIVATE PROMPT",
                path: "/private/example",
              },
            ],
          }),
        );
        const loaded = yield* store.readHostRoutines!();
        assert.equal(loaded.status, "available");
        assert.deepEqual(loaded.routines, [routine]);
        assert.notInclude(JSON.stringify(loaded), "PRIVATE");
        for (const content of [
          "{invalid",
          JSON.stringify({ routines: [{ ...routine, capability: "write" }] }),
          JSON.stringify({ routines: [{ ...routine, observedAt: "not-a-date" }] }),
          JSON.stringify({ routines: [routine, routine] }),
          JSON.stringify({
            routines: Array.from({ length: 101 }, (_, index) => ({
              ...routine,
              id: `routine-${index}`,
            })),
          }),
          " ".repeat(65537),
        ]) {
          yield* fs.writeFileString(file, content);
          assert.deepEqual(yield* store.readHostRoutines!(), {
            status: "unavailable",
            routines: [],
          });
          assert.equal(yield* fs.readFileString(file), content);
        }
        yield* fs.writeFileString(file, JSON.stringify({ routines: [] }));
        assert.deepEqual(yield* store.readHostRoutines!(), { status: "available", routines: [] });
        const otherFile = `${stateDirectory}/other.json`;
        yield* fs.rename(file, otherFile);
        yield* fs.symlink(otherFile, file);
        assert.deepEqual(yield* store.readHostRoutines!(), { status: "unavailable", routines: [] });
        assert.equal(yield* fs.readFileString(otherFile), JSON.stringify({ routines: [] }));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
