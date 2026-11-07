import * as HostProcess from "@d4research/shared/HostProcess";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
/** Opt-in authenticated CLI probe: T3_JUNIE_ACP_PROBE=1 vp test run JunieAcpCliProbe.
 * Real configOptions catch model-discovery assumptions shared by mocks. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { junieModelsFromSessionSetup } from "../Layers/JunieProvider.ts";
import { makeJunieAcpRuntime } from "./JunieAcpSupport.ts";

const protocolTag = (value: unknown): string => {
  if (typeof value !== "object" || value === null) return typeof value;
  const record = value as { readonly _tag?: unknown; readonly tag?: unknown };
  return [record._tag, record.tag]
    .filter((part): part is string => typeof part === "string")
    .join(":");
};

const recordDiagnostic = (diagnostics: Array<string>, line: string): void => {
  diagnostics.push(line);
  if (process.env.T3_JUNIE_ACP_TRACE === "1") {
    process.stderr.write(`[junie-acp-probe] ${line}\n`);
  }
};

const makeProbeRuntime = (cwd: string = process.cwd(), diagnostics?: Array<string>) =>
  // @effect-diagnostics-next-line unnecessaryEffectGen:off -- d4research probe predating this style rule.
  Effect.gen(function* () {
    return yield* makeJunieAcpRuntime({
      junieSettings: { binaryPath: "junie", defaultModel: "" },
      environment: process.env,
      cwd,
      clientInfo: { name: "t3-junie-probe", version: "0.0.0" },
      ...(diagnostics
        ? {
            requestLogger: (event) =>
              Effect.sync(() =>
                recordDiagnostic(diagnostics, `request:${event.method}:${event.status}`),
              ),
            protocolLogging: {
              logIncoming: true,
              logOutgoing: true,
              logger: (event) =>
                Effect.sync(() => {
                  if (event.stage === "decoded") {
                    recordDiagnostic(
                      diagnostics,
                      `protocol:${event.direction}:${event.stage}:${protocolTag(event.payload)}`,
                    );
                  }
                }),
            },
          }
        : {}),
    });
  });

describe.runIf(process.env.T3_JUNIE_ACP_PROBE === "1")("Junie ACP CLI probe", () => {
  it.effect("initialize succeeds against real junie stdio", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime();
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("session/new advertises models through configOptions, not SessionModelState", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime();
      const started = yield* runtime.start();
      const result = started.sessionSetupResult;

      // The exact inversion of the Grok probe, and the whole point of this
      // file: Junie leaves `models` unset and answers with a model-category
      // config option. If this flips, discovery must follow it.
      expect(result.models).toBeUndefined();
      expect(started.modelConfigId).toBeDefined();

      const discovered = junieModelsFromSessionSetup(result.configOptions, started.modelConfigId);
      expect(discovered.length).toBeGreaterThan(1);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("advertises the ids the default dev pipeline names", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime();
      const started = yield* runtime.start();
      const slugs = junieModelsFromSessionSetup(
        started.sessionSetupResult.configOptions,
        started.modelConfigId,
      ).map((model) => model.slug);

      // A pipeline directive naming an id Junie does not serve fails only once
      // a delegation is already open, which reads as a hung step, not a typo.
      expect(slugs).toContain("gemini-3.1-pro-preview");
      expect(slugs).toContain("gpt-5.6-sol");
      expect(slugs).toContain("grok-4.5");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  // oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- Opt-in real CLI inference awaits protocol events and needs its existing bounded network deadline.
  it.effect(
    "streams assistant output from a real selected-model prompt",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-junie-prompt-probe-" });
        const diagnostics: Array<string> = [];
        const runtime = yield* makeProbeRuntime(cwd, diagnostics);
        yield* runtime.handleRequestPermission((request) => {
          const option = request.options.find(
            (candidate) => candidate.kind === "allow_always" || candidate.kind === "allow_once",
          );
          return Effect.succeed({
            outcome: option
              ? { outcome: "selected" as const, optionId: option.optionId }
              : ({ outcome: "cancelled" } as const),
          });
        });
        yield* runtime.start();
        // The generated default dev pipeline prefers Junie's Grok 4.5 for its
        // BUILD role, so the ungated model in this live probe must exercise
        // that actual route rather than a merely available catalog entry.
        const model = (yield* HostProcess.Environment).T3_JUNIE_MODEL_PROBE ?? "grok-4.5";
        yield* runtime.setModel(model);
        const output = yield* Ref.make<ReadonlyArray<string>>([]);
        const eventsFiber = yield* runtime.getEvents().pipe(
          Stream.runForEach((event) => {
            recordDiagnostic(diagnostics, `event:${event._tag}`);
            if (event._tag === "EventStreamBarrier") {
              return Deferred.succeed(event.acknowledge, undefined);
            }
            return event._tag === "ContentDelta" && event.streamKind === "assistant_text"
              ? Ref.update(output, (current) => [...current, event.text])
              : Effect.void;
          }),
          Effect.forkChild,
        );

        const sentinel = "T3_JUNIE_REAL_OUTPUT_OK";
        const result = yield* runtime
          .prompt({
            prompt: [{ type: "text", text: `Return exactly this token and no prose: ${sentinel}` }],
          })
          .pipe(Effect.timeoutOption("60 seconds"));
        if (Option.isSome(result)) yield* runtime.drainEvents;
        yield* Fiber.interrupt(eventsFiber);

        expect(Option.isSome(result), diagnostics.join("\n")).toBe(true);
        if (Option.isNone(result)) return;
        expect(result.value.stopReason).not.toBe("cancelled");
        expect((yield* Ref.get(output)).join("").trim()).toBe(sentinel);
      }).pipe(
        Effect.scoped,
        Effect.timeout("90 seconds"),
        Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    100_000,
  );
});
