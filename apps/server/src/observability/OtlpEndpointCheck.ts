import type { OtlpEndpointCheckInput, OtlpEndpointCheckResult } from "@d4research/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class OtlpEndpointCheck extends Context.Service<
  OtlpEndpointCheck,
  {
    readonly check: (input: OtlpEndpointCheckInput) => Effect.Effect<OtlpEndpointCheckResult>;
  }
>()("d4research/observability/OtlpEndpointCheck") {}

// Fork policy also covers endpoint probes: no export request or credential leaves the server.
export const layer = Layer.succeed(
  OtlpEndpointCheck,
  OtlpEndpointCheck.of({
    check: Effect.fn("OtlpEndpointCheck.check")(() =>
      Effect.succeed({ _tag: "Unreachable", timedOut: false }),
    ),
  }),
);
