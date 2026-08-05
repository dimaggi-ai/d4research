// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgySettings } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  checkAgyProviderStatus,
  parseAgyModelsOutput,
  quotePosixShellArgument,
} from "./AgyProvider.ts";

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

describe("quotePosixShellArgument", () => {
  it("wraps a simple argument in single quotes", () => {
    expect(quotePosixShellArgument("hello")).toBe("'hello'");
  });

  it("passes through arguments with spaces", () => {
    expect(quotePosixShellArgument("hello world")).toBe("'hello world'");
  });

  it("escapes embedded single quotes via end-escape-reopen", () => {
    expect(quotePosixShellArgument("it's")).toBe("'it'\\''s'");
  });

  it("escapes multiple single quotes", () => {
    expect(quotePosixShellArgument("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it("handles an argument that is just a single quote", () => {
    expect(quotePosixShellArgument("'")).toBe("''\\'''");
  });

  it("preserves double quotes, backslashes, and special characters", () => {
    expect(quotePosixShellArgument('a"b\\c$d')).toBe("'a\"b\\c$d'");
  });
});

describe("PTY wrapping round-trip", () => {
  it.skipIf(process.platform !== "linux")(
    "quotePosixShellArgument produces shell-safe arguments for script -c",
    async () => {
      const { execFileSync } = await import("node:child_process");
      const args = ["/usr/bin/echo", "hello world", "it's a test", 'say "hi"'];
      const command = args.map(quotePosixShellArgument).join(" ");
      const output = execFileSync("script", ["-q", "-e", "-c", command, "/dev/null"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      const cleaned = output.replace(/\r\n/g, "\n").trim();
      expect(cleaned).toBe('hello world it\'s a test say "hi"');
    },
  );
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

  it.effect("PTY wrapping handles binary paths with spaces", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return;
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d2 agy health ")),
      );
      const binary = NodePath.join(directory, "my agy");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          binary,
          '#!/bin/sh\nif [ "$1" = "models" ]; then echo "gemini-space-path"; exit 0; fi\necho "agy 1.0.0"\n',
          { mode: 0o755 },
        ),
      );

      const snapshot = yield* checkAgyProviderStatus(
        decodeSettings({ binaryPath: binary }),
        process.env,
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toContain("gemini-space-path");
    }),
  );

  it.effect("PTY wrapping handles realistic spinner + ANSI output", () =>
    Effect.gen(function* () {
      if (process.platform !== "linux") return;
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d2-agy-health-")),
      );
      const binary = NodePath.join(directory, "agy");
      const CR = "\\r";
      const ESC = "\\033";
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          binary,
          `#!/bin/sh
if [ "$1" = "models" ]; then
  printf "${CR}\\xe2\\xa0\\x8b Fetching available models..."
  printf "${CR}\\xe2\\xa0\\x99 Fetching available models..."
  printf "${CR}${ESC}[Kgemini-spinner-test     Gemini Spinner Test\\n"
  printf "claude-spinner-test       Claude Spinner Test\\n"
  exit 0
fi
echo "agy 1.0.0"
`,
          { mode: 0o755 },
        ),
      );

      const snapshot = yield* checkAgyProviderStatus(
        decodeSettings({ binaryPath: binary }),
        process.env,
      );
      expect(snapshot.status).toBe("ready");
      const slugs = snapshot.models.map((model) => model.slug);
      expect(slugs).toContain("gemini-spinner-test");
      expect(slugs).toContain("claude-spinner-test");
      expect(slugs).not.toContain("Fetching");
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
