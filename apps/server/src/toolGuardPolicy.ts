import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import YAML from "yaml";

import type {
  ToolGuardPolicy,
  ToolGuardPolicyRule,
  ToolGuardPolicyCondition,
} from "@t3tools/contracts";
import * as ServerConfig from "./config.ts";
import { managedToolGuardPaths } from "./toolGuardLifecycle.ts";

function parseCondition(raw: unknown): ToolGuardPolicyCondition {
  if (typeof raw !== "object" || raw === null) return {};
  const obj = raw as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  if (typeof obj.field === "string") result.field = obj.field;
  if (typeof obj.operator === "string") result.operator = obj.operator;
  if (typeof obj.value === "string") result.value = obj.value;
  if (Array.isArray(obj.and)) result.and = obj.and.map(parseCondition);
  if (Array.isArray(obj.or)) result.or = obj.or.map(parseCondition);
  return result as ToolGuardPolicyCondition;
}

function parseRule(raw: unknown): ToolGuardPolicyRule | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.rule_id !== "string") return null;
  const effect = obj.effect;
  if (effect !== "deny" && effect !== "escalate" && effect !== "allow") return null;
  const citation =
    typeof obj.citation === "object" && obj.citation !== null
      ? (obj.citation as Record<string, unknown>)
      : {};
  return {
    rule_id: obj.rule_id,
    rule_type: typeof obj.rule_type === "string" ? obj.rule_type : "regex",
    conditions: parseCondition(obj.conditions),
    effect,
    citation: { excerpt: typeof citation.excerpt === "string" ? citation.excerpt : "" },
  };
}

function parsePolicy(content: string): ToolGuardPolicy | null {
  const doc = YAML.parse(content) as Record<string, unknown> | null;
  if (typeof doc !== "object" || doc === null) return null;
  if (typeof doc.policy_id !== "string") return null;

  const scope =
    typeof doc.scope === "object" && doc.scope !== null
      ? (doc.scope as Record<string, unknown>)
      : {};
  const toolNames = Array.isArray(scope.tool_names)
    ? scope.tool_names.filter((v): v is string => typeof v === "string")
    : [];
  const toolGroups = Array.isArray(scope.tool_groups)
    ? scope.tool_groups.filter((v): v is string => typeof v === "string")
    : [];
  const rawRules = Array.isArray(doc.rules) ? doc.rules : [];

  return {
    policy_id: doc.policy_id,
    name: typeof doc.name === "string" ? doc.name : "",
    version: typeof doc.version === "number" ? doc.version : 1,
    status: typeof doc.status === "string" ? doc.status : "approved",
    mode: doc.mode === "shadow" ? "shadow" : "enforcement",
    scope: { tool_names: toolNames, tool_groups: toolGroups },
    rules: rawRules.map(parseRule).filter((r): r is ToolGuardPolicyRule => r !== null),
  };
}

function serializeCondition(condition: ToolGuardPolicyCondition): unknown {
  if (condition.and) {
    return { and: condition.and.map(serializeCondition) };
  }
  if (condition.or) {
    return { or: condition.or.map(serializeCondition) };
  }
  const out: Record<string, string> = {};
  if (condition.field) out.field = condition.field;
  if (condition.operator) out.operator = condition.operator;
  if (condition.value) out.value = condition.value;
  return out;
}

function serializePolicy(policy: ToolGuardPolicy): string {
  const doc = {
    policy_id: policy.policy_id,
    name: policy.name,
    version: policy.version,
    status: policy.status,
    mode: policy.mode,
    scope: {
      tool_names: [...policy.scope.tool_names],
      tool_groups: [...policy.scope.tool_groups],
    },
    rules: policy.rules.map((rule) => ({
      rule_id: rule.rule_id,
      rule_type: rule.rule_type,
      conditions: serializeCondition(rule.conditions),
      effect: rule.effect,
      citation: { excerpt: rule.citation.excerpt },
    })),
  };
  return YAML.stringify(doc, { lineWidth: 0 });
}

function resolveActiveProfileDir(profilesDir: string, path: Pick<Path.Path, "join">) {
  return path.join(profilesDir, "local-coding");
}

export const readToolGuardPolicy = Effect.fn("readToolGuardPolicy")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const managed = managedToolGuardPaths(config.stateDir, path);
  const profileDir = resolveActiveProfileDir(managed.profiles, path);
  const policyPath = path.join(profileDir, "policy.yaml");
  if (!(yield* fileSystem.exists(policyPath))) return null;
  const content = yield* fileSystem.readFileString(policyPath);
  return parsePolicy(content);
});

export const writeToolGuardPolicy = Effect.fn("writeToolGuardPolicy")(function* (
  policy: ToolGuardPolicy,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const managed = managedToolGuardPaths(config.stateDir, path);
  const profileDir = resolveActiveProfileDir(managed.profiles, path);
  const policyPath = path.join(profileDir, "policy.yaml");
  yield* fileSystem.makeDirectory(profileDir, { recursive: true });
  yield* fileSystem.writeFileString(policyPath, serializePolicy(policy));
  const shadowDir = path.join(managed.profiles, "local-coding-shadow");
  const shadowPolicyPath = path.join(shadowDir, "policy.yaml");
  if (yield* fileSystem.exists(shadowDir)) {
    const shadowPolicy: ToolGuardPolicy = { ...policy, mode: "shadow" };
    yield* fileSystem.writeFileString(shadowPolicyPath, serializePolicy(shadowPolicy));
  }
});
