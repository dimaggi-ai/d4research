import { createEnvironmentRpcCommand } from "@d4research/client-runtime/state/runtime";
import type { EnvironmentId, PeerThreadOperation } from "@d4research/contracts";
import { WS_METHODS } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atomRegistry";

const command = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:peer-thread-request",
  tag: WS_METHODS.peerThreadsRequest,
  concurrency: { mode: "parallel" },
});

/** Loaded lazily by the relay because the command runtime includes that relay. */
export const perform = (environmentId: EnvironmentId, input: PeerThreadOperation) =>
  Effect.promise(() => command.run(appAtomRegistry, { environmentId, input })).pipe(
    Effect.flatMap((result) =>
      result._tag === "Success" ? Effect.succeed(result.value) : Effect.failCause(result.cause),
    ),
  );
