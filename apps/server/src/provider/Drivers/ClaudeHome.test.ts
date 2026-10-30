import { claudeSignedOutMessage } from "./ClaudeHome.ts";
import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeConfigDir,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("treats empty, ~/.claude, and the expanded default as the same Claude home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(path.join(NodeOS.homedir(), ".claude"));

        const config = { configDir: "", homePath: "" };
        expect(yield* resolveClaudeHomePath(config)).toBe(resolved);
        expect(yield* resolveClaudeConfigDir(config)).toBeUndefined();
        expect(yield* makeClaudeEnvironment(config)).toBe(process.env);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");
        const config = { configDir: "", homePath };

        expect(yield* resolveClaudeHomePath(config)).toBe(resolved);
        expect((yield* makeClaudeEnvironment(config)).HOME).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey(config)).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", ...config })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("sets CLAUDE_CONFIG_DIR directly for account-specific profiles", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const config = { configDir: "~/.claude-personal", homePath: "" };
        const resolvedHome = path.resolve(NodeOS.homedir(), ".claude");
        const resolvedConfigDir = path.resolve(NodeOS.homedir(), ".claude-personal");
        const environment = yield* makeClaudeEnvironment(config, { PATH: "/usr/bin" });

        expect(yield* resolveClaudeConfigDir(config)).toBe(resolvedConfigDir);
        expect(environment).toEqual({
          PATH: "/usr/bin",
          CLAUDE_CONFIG_DIR: resolvedConfigDir,
        });
        expect(yield* makeClaudeContinuationGroupKey(config)).toBe(
          `claude:config:${resolvedConfigDir}:home:${resolvedHome}`,
        );
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", ...config })).toBe(
          `claude\0${resolvedHome}\0${resolvedConfigDir}\0`,
        );
      }),
    );

    it.effect("applies config directory and HOME overrides together", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const config = { configDir: "~/.claude-work", homePath: "~/work-home" };
        const environment = yield* makeClaudeEnvironment(config);

        expect(environment.HOME).toBe(path.resolve(NodeOS.homedir(), "work-home"));
        expect(environment.CLAUDE_CONFIG_DIR).toBe(path.resolve(NodeOS.homedir(), ".claude-work"));
      }),
    );
    it("points the signed-out hint at the configured Claude home", () => {
      expect(claudeSignedOutMessage({ configDir: undefined, cwd: "/synthetic" })).toContain(
        "run `claude auth login`",
      );
      const configDir = "/synthetic/Claude work's $literal";
      const message = claudeSignedOutMessage({ configDir, cwd: "/synthetic/project" });
      expect(message).toContain(`CLAUDE_CONFIG_DIR set to "${configDir}"`);
      expect(message).not.toContain("CLAUDE_CONFIG_DIR=");
      expect(message).toContain("then start a new thread");
    });

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", configDir: "", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir(), ".claude");

        expect(yield* makeClaudeContinuationGroupKey({ configDir: "", homePath: "" })).toBe(
          `claude:home:${resolved}`,
        );
      }),
    );
  });
});
