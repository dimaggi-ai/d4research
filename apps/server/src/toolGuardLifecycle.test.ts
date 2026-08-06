// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as ServerConfig from "./config.ts";
import {
  addManagedHook,
  findToolGuardBinary,
  managedToolGuardPaths,
  managedToolGuardCommand,
  manageToolGuard,
  removeManagedHook,
  removeExternalToolGuardHooks,
  TOOL_GUARD_MANAGED_MARKER,
} from "./toolGuardLifecycle.ts";

describe("Tool Guard hook configuration", () => {
  it("adds and removes only the d4research-managed hook", () => {
    const original = {
      hooks: {
        PreToolUse: [{ matcher: "Existing", hooks: [{ command: "/external/hook" }] }],
      },
      untouched: true,
    };
    const installed = addManagedHook(original, "/managed/hook");
    expect(JSON.stringify(installed)).toContain(TOOL_GUARD_MANAGED_MARKER);
    expect((installed.hooks as { PreToolUse: unknown[] }).PreToolUse).toHaveLength(2);

    const removed = removeManagedHook(installed);
    expect(removed).toEqual(original);
  });

  it("builds native managed paths and hook commands for Windows", () => {
    const paths = managedToolGuardPaths("C:\\state", NodePath.win32, "win32");
    expect(paths.binary).toBe("C:\\state\\tool-guard\\integration\\bin\\tg.exe");
    expect(paths.hook).toBe(
      "C:\\state\\tool-guard\\integration\\scripts\\t3research-tool-guard-hook.ps1",
    );
    expect(managedToolGuardCommand(paths.hook, "win32")).toBe(
      'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\\state\\tool-guard\\integration\\scripts\\t3research-tool-guard-hook.ps1"',
    );
  });

  it("removes only external Tool Guard entries across hook events", () => {
    const original = {
      hooks: {
        PreToolUse: [
          { hooks: [{ command: "/tools/tg-guard/hook.sh" }] },
          { hooks: [{ command: "python /hooks/secret-leak-guard.py" }] },
        ],
        PostToolUse: [{ hooks: [{ command: "/tools/tg-guard/hook-postresolve.sh" }] }],
        SessionStart: [{ hooks: [{ command: "python /hooks/session-validator.py" }] }],
      },
      untouched: true,
    };

    expect(removeExternalToolGuardHooks(original)).toEqual({
      hooks: {
        PreToolUse: [{ hooks: [{ command: "python /hooks/secret-leak-guard.py" }] }],
        SessionStart: [{ hooks: [{ command: "python /hooks/session-validator.py" }] }],
      },
      untouched: true,
    });
  });
});

it.layer(NodeServices.layer)("Tool Guard Core discovery", (it) => {
  it.effect("finds Core on PATH", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d2-tool-guard-path-test-")),
      );
      const environment = yield* HostProcessEnvironment;
      const binary = NodePath.join(root, "tg");
      yield* Effect.promise(() => NodeFSP.writeFile(binary, "", { mode: 0o755 }));
      const previousPath = environment.PATH;
      environment.PATH = `${root}${NodePath.delimiter}${previousPath ?? ""}`;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousPath === undefined) delete environment.PATH;
          else environment.PATH = previousPath;
        }),
      );

      expect(yield* findToolGuardBinary()).toBe(binary);
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessEnvironment, { ...process.env }),
    ),
  );
});

it.layer(NodeServices.layer)("Tool Guard lifecycle", (it) => {
  it.effect("installs, disables, enables, and uninstalls environment-local resources", () =>
    Effect.gen(function* () {
      const environment = yield* HostProcessEnvironment;
      const root = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d2-tool-guard-test-")),
      );
      const home = NodePath.join(root, "home");
      const resources = NodePath.join(root, "resources");
      const binary = NodePath.join(root, "tg");
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.mkdir(NodePath.join(resources, "profiles", "local-coding"), {
            recursive: true,
          }),
          NodeFSP.mkdir(NodePath.join(resources, "profiles", "local-coding-shadow"), {
            recursive: true,
          }),
          NodeFSP.mkdir(NodePath.join(resources, "scripts"), { recursive: true }),
          NodeFSP.mkdir(home, { recursive: true }),
        ]),
      );
      yield* Effect.promise(() =>
        Promise.all([
          NodeFSP.writeFile(binary, "#!/bin/sh\n", { mode: 0o755 }),
          NodeFSP.writeFile(
            NodePath.join(resources, "profiles", "local-coding", "policy.yaml"),
            "mode: enforcement\n",
          ),
          NodeFSP.writeFile(
            NodePath.join(resources, "profiles", "local-coding-shadow", "policy.yaml"),
            "mode: shadow\n",
          ),
          NodeFSP.writeFile(
            NodePath.join(resources, "scripts", "t3research-tool-guard-hook"),
            "#!/bin/sh\n",
          ),
          NodeFSP.writeFile(
            NodePath.join(resources, "scripts", "t3research-tool-guard-agy-hook"),
            "#!/bin/sh\n",
          ),
        ]),
      );

      const previousHome = environment.HOME;
      const previousBinary = environment.T3RESEARCH_TOOL_GUARD_BIN;
      const previousResources = environment.D4RESEARCH_TOOL_GUARD_RESOURCES;
      environment.HOME = home;
      environment.T3RESEARCH_TOOL_GUARD_BIN = binary;
      environment.D4RESEARCH_TOOL_GUARD_RESOURCES = resources;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousHome === undefined) delete environment.HOME;
          else environment.HOME = previousHome;
          if (previousBinary === undefined) delete environment.T3RESEARCH_TOOL_GUARD_BIN;
          else environment.T3RESEARCH_TOOL_GUARD_BIN = previousBinary;
          if (previousResources === undefined) delete environment.D4RESEARCH_TOOL_GUARD_RESOURCES;
          else environment.D4RESEARCH_TOOL_GUARD_RESOURCES = previousResources;
        }),
      );

      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(home, ".claude"), { recursive: true }).then(() =>
          NodeFSP.writeFile(NodePath.join(home, ".claude/settings.json"), "not-json"),
        ),
      );
      expect((yield* manageToolGuard("install")).ok).toBe(false);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(home, ".claude/settings.json"), "utf8"),
        ),
      ).toBe("not-json");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(home, ".claude/settings.json"), '{"existing":true}\n'),
      );

      expect((yield* manageToolGuard("install")).ok).toBe(true);
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const managed = managedToolGuardPaths(config.stateDir, path, platform);
      expect(yield* Effect.promise(() => NodeFSP.readFile(managed.manifest, "utf8"))).toContain(
        '"enabled": true',
      );
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(home, ".claude/settings.json"), "utf8"),
        ),
      ).toContain(TOOL_GUARD_MANAGED_MARKER);

      expect((yield* manageToolGuard("disable")).ok).toBe(true);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(home, ".claude/settings.json"), "utf8"),
        ),
      ).not.toContain(TOOL_GUARD_MANAGED_MARKER);
      expect((yield* manageToolGuard("enable")).ok).toBe(true);
      expect((yield* manageToolGuard("uninstall")).ok).toBe(true);
      expect(
        yield* Effect.promise(() =>
          NodeFSP.access(managed.root).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "tg" })),
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HostProcessEnvironment, { ...process.env }),
    ),
  );
});
