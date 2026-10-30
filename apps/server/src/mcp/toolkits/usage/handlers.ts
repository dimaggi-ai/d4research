import { OrchestratorMcpFailure } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as UsageSnapshots from "../../../usage/UsageSnapshots.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { UsageToolkit } from "./tools.ts";

const access = Effect.gen(function* () {
  const caller = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== caller.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return {
    ...caller,
    environmentId: descriptor.environmentId,
    snapshots: yield* UsageSnapshots.UsageSnapshots,
  };
});

export const layer = McpToolAccess.toLayer(UsageToolkit, {
  t3_usage_limits_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { scope, environmentId, snapshots } = yield* access;
      return {
        environmentId,
        currentProviderInstanceId: scope.thread?.providerInstanceId ?? null,
        ...(yield* snapshots.readLimits(input)),
      };
    }),
  ),
  t3_usage_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { snapshots } = yield* access;
      return yield* snapshots.readUsage(input).pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: error.reason === "invalidWindow" ? "invalid_request" : "orchestration_error",
              message: error.message,
            }),
        ),
      );
    }),
  ),
});
