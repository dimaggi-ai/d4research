// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgySettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { checkAgyProviderStatus, parseAgyModelsOutput } from "./AgyProvider.ts";

const decodeSettings = Schema.decodeSync(AgySettings);

describe("parseAgyModelsOutput", () => {
  const ESC = String.fromCharCode(0x1b);
  const CR = "\r";
  const LF = "\n";

  it("strips spinner frames, ANSI escapes, and columns", () => {
    const stdout =
      CR +
      "⠋ Fetching available models..." +
      CR +
      "⠙ Fetching available models..." +
      CR +
      "⠼ Fetching available models..." +
      CR +
      ESC +
      "[Kgemini-3.6-flash-high     Gemini 3.6 Flash (High)" +
      CR +
      LF +
      "gemini-3.5-flash-medium   Gemini 3.5 Flash (Medium)" +
      CR +
      LF +
      "claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)" +
      CR +
      LF;

    const parsed = parseAgyModelsOutput(stdout);
    expect(parsed).toEqual([
      { slug: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)" },
      { slug: "gemini-3.5-flash-medium", name: "Gemini 3.5 Flash (Medium)" },
      { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
    ]);
  });

  it("skips lingering spinner frames without model rows", () => {
    const stdout = "⠋ Fetching available models..." + CR + LF;
    expect(parseAgyModelsOutput(stdout)).toEqual([]);
  });

  it("accepts a slug-only line without a description column", () => {
    expect(parseAgyModelsOutput("gemini-only" + LF)).toEqual([
      { slug: "gemini-only", name: "gemini-only" },
    ]);
  });
});

it.layer(NodeServices.layer)("Agy provider health", (it) => {
  it.effect("uses a PTY for model discovery when Agy requires one", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return;
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d2-agy-health-")),
      );
      const binary = NodePath.join(directory, "agy");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          binary,
          '#!/bin/sh\nif [ "$1" = "models" ]; then\n  if [ -t 1 ]; then echo "gemini-pty"; exit 0; fi\n  sleep 25\nfi\necho "agy 1.0.0"\n',
          { mode: 0o755 },
        ),
      );

      const snapshot = yield* checkAgyProviderStatus(
        decodeSettings({ binaryPath: binary }),
        process.env,
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toContain("gemini-pty");
    }),
  );

  it.effect("allows a cold model discovery to finish before reporting a timeout", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d2-agy-health-")),
      );
      const binary = NodePath.join(directory, "agy");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          binary,
          '#!/bin/sh\nif [ "$1" = "models" ]; then sleep 9; echo "gemini-cold-start"; exit 0; fi\necho "agy 1.0.0"\n',
          { mode: 0o755 },
        ),
      );

      const snapshot = yield* checkAgyProviderStatus(
        decodeSettings({ binaryPath: binary }),
        process.env,
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toContain("gemini-cold-start");
    }),
  );

  it.effect("keeps model discovery ready when the version probe fails", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d2-agy-health-")),
      );
      const binary = NodePath.join(directory, "agy");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          binary,
          '#!/bin/sh\nif [ "$1" = "models" ]; then echo "gemini-test"; exit 0; fi\necho "version unavailable" >&2\nexit 1\n',
          { mode: 0o755 },
        ),
      );

      const snapshot = yield* checkAgyProviderStatus(
        decodeSettings({ binaryPath: binary }),
        process.env,
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBeNull();
      expect(snapshot.models.map((model) => model.slug)).toContain("gemini-test");
    }),
  );

  it.effect("reports bounded model discovery stderr", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d2-agy-health-")),
      );
      const binary = NodePath.join(directory, "agy");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(binary, '#!/bin/sh\necho "connector config is invalid" >&2\nexit 1\n', {
          mode: 0o755,
        }),
      );

      const snapshot = yield* checkAgyProviderStatus(
        decodeSettings({ binaryPath: binary }),
        process.env,
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("connector config is invalid");
    }),
  );
});
