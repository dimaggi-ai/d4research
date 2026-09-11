// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ToolGuardPolicy } from "@d4research/contracts";
import { HostProcessPlatform } from "@d4research/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "./config.ts";
import { managedToolGuardPaths } from "./toolGuardLifecycle.ts";
import { readToolGuardPolicy, writeToolGuardPolicy } from "./toolGuardPolicy.ts";

const managedPolicy: ToolGuardPolicy = {
  policy_id: "d4-policy-test",
  name: "d4 policy test",
  version: 7,
  status: "approved",
  mode: "enforcement",
  scope: {
    tool_names: ["bash", "run_command"],
    tool_groups: ["shell"],
  },
  rules: [
    {
      rule_id: "review-publish",
      rule_type: "regex",
      conditions: {
        and: [
          { field: "parameters.command", operator: "regex", value: "git\\s+push" },
          {
            or: [
              { field: "parameters.command", operator: "contains", value: "--force" },
              { field: "parameters.command", operator: "contains", value: "--delete" },
            ],
          },
        ],
      },
      effect: "escalate",
      citation: { excerpt: "Publishing destructive changes requires review." },
    },
  ],
};

describe("Tool Guard policy storage", () => {
  it.effect("reads the bundled policy before a managed installation exists", () =>
    Effect.gen(function* () {
      const result = yield* readToolGuardPolicy();

      expect(result?.source).toBe("bundled");
      expect(result?.policy.policy_id).toBe("t3research-local-coding");
      expect(result?.policy.mode).toBe("enforcement");
      expect(result?.policy.rules.length).toBeGreaterThan(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "tg-policy-bundled-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          NodeServices.layer,
          Layer.succeed(HostProcessPlatform, "linux"),
        ),
      ),
    ),
  );

  it.effect("round-trips a managed policy and keeps the shadow profile audit-only", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const paths = managedToolGuardPaths(config.stateDir, path, "linux");
      const shadowDirectory = path.join(paths.profiles, "local-coding-shadow");
      yield* Effect.promise(() => NodeFSP.mkdir(shadowDirectory, { recursive: true }));

      yield* writeToolGuardPolicy(managedPolicy);

      const result = yield* readToolGuardPolicy();
      expect(result).toEqual({ policy: managedPolicy, source: "managed" });

      const shadow = yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(shadowDirectory, "policy.yaml"), "utf8"),
      );
      expect(shadow).toContain("policy_id: d4-policy-test");
      expect(shadow).toContain("mode: shadow");
      expect(shadow).toContain("rule_id: review-publish");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "tg-policy-managed-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          NodeServices.layer,
          Layer.succeed(HostProcessPlatform, "linux"),
        ),
      ),
    ),
  );
});
