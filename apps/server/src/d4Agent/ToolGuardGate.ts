import type { D4AgentGuardVerdict } from "@d4research/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { isLocalCtoHost } from "./cto/CtoClient.ts";

// tg-proxy flattens parameters one level deep, so every value a policy matches must be a scalar.
export type ToolGuardEnvelope = {
  readonly envelope_id: string;
  readonly agent_id: "nia";
  readonly session_id: string;
  readonly org_id: "d4research";
  readonly tool_name: "d4_agent_action";
  readonly tool_group: "d4_agent";
  readonly parameters: Readonly<Record<string, string | number | boolean>>;
};

export class ToolGuardGate extends Context.Service<
  ToolGuardGate,
  {
    readonly evaluate: (
      url: string,
      envelope: ToolGuardEnvelope,
    ) => Effect.Effect<D4AgentGuardVerdict>;
  }
>()("d4research/d4Agent/ToolGuardGate") {}

const Response = Schema.Struct({
  decision: Schema.Literals(["allowed", "flagged", "escalated", "denied"]),
  decision_reason: Schema.optionalKey(Schema.String),
  rule_results: Schema.optionalKey(
    Schema.Array(Schema.Struct({ rule_id: Schema.String, matched: Schema.Boolean })),
  ),
});
const decodeResponse = Schema.decodeUnknownEffect(Response);

// Any failure to get a verdict sends the action to a human instead of letting it run.
const unavailable = (reason: string): D4AgentGuardVerdict => ({
  decision: "unavailable",
  rule: null,
  reason,
});

export const evaluateWithProxy = (url: string, envelope: ToolGuardEnvelope) =>
  Effect.gen(function* () {
    const base = yield* Effect.try({ try: () => new URL(url), catch: () => "invalid" as const });
    if (base.protocol !== "http:" || !isLocalCtoHost(base.hostname))
      return unavailable("Tool Guard URL must be a local http address.");
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(new URL("/evaluate", base).href).pipe(
        HttpClientRequest.bodyJsonUnsafe(envelope),
      ),
    );
    if (response.status !== 200 && response.status !== 202)
      return unavailable(`Tool Guard answered HTTP ${response.status}.`);
    const body = yield* decodeResponse(yield* response.json);
    return {
      decision: body.decision,
      rule: body.rule_results?.find((entry) => entry.matched)?.rule_id.slice(0, 256) ?? null,
      reason: body.decision_reason?.slice(0, 512) ?? null,
    } satisfies D4AgentGuardVerdict;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOrElse({
      duration: "3 seconds",
      orElse: () => Effect.succeed(unavailable("Tool Guard did not answer in 3 seconds.")),
    }),
    Effect.catch(() => Effect.succeed(unavailable("Tool Guard is unreachable."))),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.provide(FetchHttpClient.layer),
  );

export const proxyGate = ToolGuardGate.of({ evaluate: evaluateWithProxy });
