/**
 * Optional integration check against a real, signed-in `muse` install.
 * Enable with: T3_MUSE_MSP_PROBE=1 vp test run MuseCliProbe
 *
 * The mock host in `scripts/msp-mock-host.ts` was written from the exported
 * MSP schema, so it agrees with our own assumptions by construction. Only the
 * real CLI can disagree. This probe runs the status check, one adapter turn,
 * and one text generation through the real binary, in a scratch workspace
 * outside the repo so Muse's TMPDIR rule and session log never touch it.
 */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@d4research/contracts";
import { Effect, FileSystem, Layer, Queue, Stream } from "effect";
import { describe } from "vite-plus/test";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { makeMuseTextGeneration } from "../../textGeneration/MuseTextGeneration.ts";
import { makeMuseAdapter } from "../Layers/MuseAdapter.ts";
import { checkMuseProviderStatus } from "../Layers/MuseProvider.ts";

const settings = {
  enabled: true,
  binaryPath: process.env.T3_MUSE_BINARY ?? "muse",
  model: "",
  disableSandbox: false,
  sandboxNetwork: "",
  customModels: [],
} as const;

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "muse-cli-probe-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const museSessionsRoot = NodePath.join(NodeOS.homedir(), ".local", "share", "muse", "sessions");
const listSessionLogs = (dir: string, out: Array<string> = []): Array<string> => {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) listSessionLogs(full, out);
    else if (entry.name === "session.jsonl") out.push(full);
  }
  return out;
};

const scratchWorkspace = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "muse-cli-probe-" });
});

describe.runIf(process.env.T3_MUSE_MSP_PROBE === "1")("Muse CLI probe", () => {
  it.layer(layer)("real muse serve", (it) => {
    it.effect(
      "status check reports a signed-in install with a model catalog",
      () =>
        Effect.gen(function* () {
          const snapshot = yield* checkMuseProviderStatus(settings);
          assert.equal(snapshot.status, "ready", snapshot.message);
          assert.equal(snapshot.auth.status, "authenticated");
          assert.isAtLeast(snapshot.models.length, 1);
          assert.isTrue(snapshot.models.some((model) => model.isDefault));
        }),
      60_000,
    );

    it.effect(
      "completes a real turn with streamed assistant text",
      () =>
        Effect.gen(function* () {
          const cwd = yield* scratchWorkspace;
          const adapter = yield* makeMuseAdapter(settings);
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          const events: ProviderRuntimeEvent[] = [];
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) => {
              events.push(event);
              return Queue.offer(queue, event);
            }),
            Effect.forkScoped({ startImmediately: true }),
          );
          const threadId = ThreadId.make("muse-cli-probe");
          yield* adapter.startSession({ threadId, cwd, runtimeMode: "approval-required" });
          const sent = yield* adapter.sendTurn({
            threadId,
            input: "Reply with exactly the word PONG and nothing else.",
          });
          assert.equal(sent.turnId[14], "7");
          const completed = yield* Effect.gen(function* () {
            while (true) {
              const event = yield* Queue.take(queue);
              if (event.type === "turn.completed") return event;
            }
          });
          assert.equal(
            completed.payload.state,
            "completed",
            completed.payload.state === "failed" ? completed.payload.errorMessage : undefined,
          );
          const text = events
            .filter((event) => event.type === "content.delta")
            .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
            .join("");
          assert.include(text, "PONG");
          assert.isTrue(events.some((event) => event.type === "thread.started"));
          yield* adapter.stopAll();
        }),
      120_000,
    );

    it.effect(
      "starts a session with the t3-code MCP server configured (sessionMcp capability)",
      () =>
        Effect.gen(function* () {
          const cwd = yield* scratchWorkspace;
          const adapter = yield* makeMuseAdapter(settings);
          const events: ProviderRuntimeEvent[] = [];
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
            Effect.forkScoped({ startImmediately: true }),
          );
          const threadId = ThreadId.make("muse-cli-probe-mcp");
          McpProviderSession.setMcpProviderSession({
            environmentId: EnvironmentId.make("probe"),
            threadId,
            providerSessionId: "probe-session",
            providerInstanceId: ProviderInstanceId.make("muse"),
            endpoint: "http://127.0.0.1:1/mcp",
            authorizationHeader: "Bearer probe",
            capabilities: new Set(["preview"]),
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
          );
          const started = yield* adapter.startSession({
            threadId,
            cwd,
            runtimeMode: "approval-required",
          });
          assert.isDefined(started.resumeCursor);
          assert.isFalse(
            events.some(
              (event) =>
                event.type === "runtime.warning" && event.payload.message.includes("sessionMcp"),
            ),
          );
          yield* adapter.stopAll();
        }),
      60_000,
    );

    it.effect(
      "switches to plan posture and back without losing the session",
      () =>
        Effect.gen(function* () {
          const cwd = yield* scratchWorkspace;
          const adapter = yield* makeMuseAdapter(settings);
          const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) => Queue.offer(queue, event)),
            Effect.forkScoped({ startImmediately: true }),
          );
          const take = <T extends ProviderRuntimeEvent["type"]>(type: T) =>
            Effect.gen(function* () {
              while (true) {
                const event = yield* Queue.take(queue);
                if (event.type === type) return event as Extract<ProviderRuntimeEvent, { type: T }>;
              }
            });
          const threadId = ThreadId.make("muse-cli-probe-plan");
          yield* adapter.startSession({ threadId, cwd, runtimeMode: "approval-required" });
          // The respawn and same-session resume inside sendTurn must succeed
          // for the turn to complete; a failed resume surfaces as a turn error.
          yield* adapter.sendTurn({
            threadId,
            input: "Reply with exactly the word PLAN.",
            interactionMode: "plan",
          });
          assert.equal((yield* take("turn.completed")).payload.state, "completed");
          yield* adapter.sendTurn({
            threadId,
            input: "Reply with exactly the word BACK.",
            interactionMode: "default",
          });
          assert.equal((yield* take("turn.completed")).payload.state, "completed");
          yield* adapter.stopAll();
        }),
      240_000,
    );

    it.effect(
      "text generation returns structured JSON without leaking history",
      () =>
        Effect.gen(function* () {
          const cwd = yield* scratchWorkspace;
          const generation = yield* makeMuseTextGeneration(settings);
          const logsBefore = new Set(
            NodeFS.existsSync(museSessionsRoot) ? listSessionLogs(museSessionsRoot) : [],
          );
          const result = yield* generation.generateThreadTitle({
            cwd,
            modelSelection: { instanceId: ProviderInstanceId.make("muse"), model: "default" },
            message: "Add a Muse provider driver that speaks MSP over stdio",
          });
          assert.isString(result.title);
          assert.isAbove(result.title.length, 0);
          // The generation session must leave no log behind: any session
          // log that appears during this generation is a leak. Snapshot by
          // path, since live stores also hold unrelated sessions.
          const after = NodeFS.existsSync(museSessionsRoot)
            ? listSessionLogs(museSessionsRoot)
            : [];
          const leaked = after.filter((path) => !logsBefore.has(path));
          assert.deepEqual(leaked, []);
        }),
      120_000,
    );
  });
});
