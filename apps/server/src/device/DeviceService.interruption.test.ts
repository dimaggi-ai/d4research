import { expect, it } from "@effect/vitest";
import { LOCAL_DEVICE_HOST_ID } from "@d4research/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as DeviceService from "./DeviceService.ts";

it.effect.each([
  { tool: "hub", phase: "installing" },
  { tool: "hub", phase: "starting" },
  { tool: "agent", phase: "installing" },
  { tool: "agent", phase: "starting" },
] as const)("recovers after interrupting $tool setup while $phase", ({ tool, phase }) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finishSetup = yield* Deferred.make<void>();
    const ready: DeviceHost.DeviceHostAgentReady = {
      nodePath: process.execPath,
      hub: { origin: "http://device.test" },
      agentDevice: { baseUrl: "http://agent.test", token: "test", entryPath: "/agent" },
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      run: () => Effect.die("Unexpected process"),
      devices: {
        list: Effect.succeed({ devices: [], detail: undefined }),
        boot: () => Effect.die("Unexpected device boot"),
        attach: () => Effect.die("Unexpected device attach"),
        shutdown: () => Effect.die("Unexpected device shutdown"),
        screenshot: () => Effect.die("Unexpected screenshot"),
      },
    };
    const ensureReady = Effect.fn("test.ensureReady")(function* (
      onPhase: Parameters<DeviceHost.DeviceHost["Service"]["ensureReady"]>[0],
    ) {
      yield* onPhase(phase, "Setup in progress");
      yield* Deferred.succeed(started, undefined);
      yield* Deferred.await(finishSetup);
      return ready;
    });
    const host: DeviceHost.DeviceHost["Service"] = {
      id: LOCAL_DEVICE_HOST_ID,
      label: "This machine",
      summary: Effect.succeed({
        id: LOCAL_DEVICE_HOST_ID,
        label: "This machine",
        kind: "local",
        platforms: [{ platform: "ios", available: true }],
        hubInstalled: false,
        agentDeviceInstalled: false,
      }),
      platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
      ensureReady,
      ensureAgentReady: ensureReady,
      current: Effect.succeed(null),
      stop: Effect.void,
      stopAgent: Effect.void,
    };
    const service = yield* DeviceService.makeWithHosts(new Map([[host.id, host]]));
    const configuring = yield* service
      .configure({ enabled: true, agentAccessEnabled: tool === "agent" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    expect((yield* service.state).hostStatus).toBe(phase);

    yield* Fiber.interrupt(configuring);
    expect(Exit.isFailure(yield* Fiber.await(configuring))).toBe(true);
    const interrupted = yield* service.state;
    expect(interrupted.hostStatus).toBe("failed");
    expect(interrupted.hostStatusDetail).toBeUndefined();
    expect(interrupted.hostStatuses[host.id]).toEqual({ status: "failed" });
    expect(interrupted.supportsHostRetry).toBe(true);

    yield* Deferred.succeed(finishSetup, undefined);
    const retried = yield* service.retryHost(host.id);
    expect(retried.hostStatus).toBe("ready");
    expect(retried.hostStatuses[host.id]?.status).toBe("ready");
    expect((yield* service.configure({ enabled: false })).hostStatus).toBe("disabled");
  }).pipe(
    Effect.provide([
      NodeCrypto.layer,
      ServerSettings.layerTest({ enableDeviceSupport: false, enableAgentDeviceAccess: false }),
    ]),
  ),
);
