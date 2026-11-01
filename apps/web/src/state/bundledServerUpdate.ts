import {
  WS_METHODS,
  type BundledServerRuntime,
  type DesktopBundledServerUpdateInput,
} from "@d4research/contracts";
import { EnvironmentRegistry } from "@d4research/client-runtime/connection";
import { subscribe } from "@d4research/client-runtime/rpc";
import { createRuntimeCommand } from "@d4research/client-runtime/state/runtime";
import {
  serverUpdateStateAtom,
  type ServerUpdateStage,
} from "@d4research/client-runtime/state/server";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { connectionAtomRuntime } from "../connection/runtime";
import { useBundledServerRuntime } from "./desktopUpdate";
import { useEnvironments } from "./environments";
import { resolveBundledServerUpdate } from "./bundledServerUpdate.logic";

export function useResolveBundledServerUpdate() {
  const runtime = useBundledServerRuntime();
  const { environments } = useEnvironments();
  return (environmentId: DesktopBundledServerUpdateInput["environmentId"]) =>
    resolveBundledServerUpdate(
      environments.find((environment) => environment.environmentId === environmentId) ?? null,
      runtime,
    );
}

class BundledServerReconnectError extends Data.TaggedError("BundledServerReconnectError")<{}> {
  override get message() {
    return "The updated server did not reconnect.";
  }
}

export const updateBundledServer = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-data:server:update-bundled-server",
  concurrency: {
    mode: "singleFlight",
    key: (
      target: DesktopBundledServerUpdateInput & {
        readonly version: string;
        readonly fromVersion: string;
      },
    ) => target.environmentId,
  },
  execute: (target, registry) => {
    const atom = serverUpdateStateAtom(target.environmentId);
    const state = { fromVersion: target.fromVersion, targetVersion: target.version };
    let stage: ServerUpdateStage = "installing";
    return Effect.gen(function* () {
      registry.set(atom, { status: "running", stage: "installing", ...state });
      const result = yield* Effect.tryPromise(() => {
        const update = window.desktopBridge?.updateBundledSshServer;
        if (!update) throw new Error("This desktop app cannot upload its server runtime.");
        return update(target);
      });
      stage = "resuming";
      registry.set(atom, { status: "running", stage, ...state });
      const environments = yield* EnvironmentRegistry.EnvironmentRegistry;
      const observed = yield* environments
        .followStream(target.environmentId, subscribe(WS_METHODS.subscribeServerConfig, {}))
        .pipe(
          Stream.filter(
            (event) =>
              event.type === "snapshot" &&
              event.config.environment.serverBuildId === target.buildId &&
              event.config.environment.serverVersion === target.version,
          ),
          Stream.runHead,
          Effect.timeout("60 seconds"),
        );
      if (Option.isNone(observed)) return yield* new BundledServerReconnectError();
      return result satisfies BundledServerRuntime;
    }).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          registry.set(
            atom,
            Exit.isSuccess(exit)
              ? { status: "idle" }
              : {
                  status: "failed",
                  stage,
                  ...state,
                  message: String(Cause.squash(exit.cause)),
                },
          );
        }),
      ),
    );
  },
});
