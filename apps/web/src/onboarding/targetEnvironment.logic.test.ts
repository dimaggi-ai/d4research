import { EnvironmentId } from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveOnboardingSetup,
  resolveOnboardingTargetEnvironment,
} from "./targetEnvironment.logic";

const primaryEnvironment = {
  environmentId: EnvironmentId.make("primary"),
  connection: { phase: "connected" },
  label: "This computer",
} as const;

const olderRemote = {
  environmentId: EnvironmentId.make("older-remote"),
  connection: { phase: "connected" },
  label: "Older computer",
} as const;

const newerRemote = {
  environmentId: EnvironmentId.make("newer-remote"),
  connection: { phase: "connected" },
  label: "New computer",
} as const;

const pairedRemote = {
  environmentId: EnvironmentId.make("paired-remote"),
  connection: { phase: "connected" },
  label: "Direct computer",
} as const;

const sshEnvironment = {
  environmentId: EnvironmentId.make("ssh-remote"),
  connection: { phase: "connected" },
  label: "SSH computer",
} as const;

const desktopLocalEnvironment = {
  environmentId: EnvironmentId.make("desktop-local-wsl"),
  connection: { phase: "connected" },
  label: "WSL",
} as const;

describe("resolveOnboardingTargetEnvironment", () => {
  it("waits for the exact paired machine instead of using an older connected machine", () => {
    const pendingPairedRemote = { ...pairedRemote, connection: { phase: "connecting" } };

    expect(
      resolveOnboardingTargetEnvironment({
        mode: "direct",
        environments: [primaryEnvironment, olderRemote, pendingPairedRemote],
        primaryEnvironment,
        pairedEnvironmentId: pairedRemote.environmentId,
      }),
    ).toBeNull();
  });

  it("uses the exact paired machine once it connects", () => {
    expect(
      resolveOnboardingTargetEnvironment({
        mode: "direct",
        environments: [primaryEnvironment, olderRemote, pairedRemote],
        primaryEnvironment,
        pairedEnvironmentId: pairedRemote.environmentId,
      }),
    ).toBe(pairedRemote);
  });

  it("does not substitute a remote machine when the local primary is offline", () => {
    const offlinePrimary = { ...primaryEnvironment, connection: { phase: "disconnected" } };

    expect(
      resolveOnboardingTargetEnvironment({
        mode: "local",
        environments: [offlinePrimary, olderRemote],
        primaryEnvironment: offlinePrimary,
        pairedEnvironmentId: null,
      }),
    ).toBeNull();
  });

  it("uses the primary environment when relay setup is unavailable", () => {
    expect(
      resolveOnboardingTargetEnvironment({
        mode: "connect",
        environments: [primaryEnvironment, olderRemote, newerRemote],
        primaryEnvironment,
        pairedEnvironmentId: null,
      }),
    ).toBe(primaryEnvironment);
  });

  it("does not substitute another route for the primary environment in Connect mode", () => {
    expect(
      resolveOnboardingTargetEnvironment({
        mode: "connect",
        environments: [
          primaryEnvironment,
          olderRemote,
          pairedRemote,
          sshEnvironment,
          desktopLocalEnvironment,
        ],
        primaryEnvironment,
        pairedEnvironmentId: null,
      }),
    ).toBe(primaryEnvironment);
  });

  it("uses the primary computer when no relay connection exists", () => {
    expect(
      resolveOnboardingTargetEnvironment({
        mode: "connect",
        environments: [primaryEnvironment, pairedRemote, sshEnvironment, desktopLocalEnvironment],
        primaryEnvironment,
        pairedEnvironmentId: null,
      }),
    ).toBe(primaryEnvironment);
  });
});

describe("resolveOnboardingSetup", () => {
  const computer = (id: string, phase: string) => ({
    environmentId: EnvironmentId.make(id),
    connection: { phase },
  });
  const local = computer("local", "connected");

  it("skips selected computers that will not connect on their own", () => {
    const environments = [
      local,
      computer("switched-off", "available"),
      computer("offline", "offline"),
      computer("failing", "reconnecting"),
      computer("old-client", "unsupported"),
    ];
    expect(
      resolveOnboardingSetup(
        environments,
        new Set(environments.map((environment) => environment.environmentId)),
      ),
    ).toEqual({
      ready: true,
      environmentIds: [local.environmentId],
      skippedIds: environments.slice(1).map((environment) => environment.environmentId),
    });
  });

  it("waits for a first connection attempt to settle", () => {
    const connecting = computer("new", "connecting");
    expect(
      resolveOnboardingSetup(
        [local, connecting],
        new Set([local.environmentId, connecting.environmentId]),
      ).ready,
    ).toBe(false);
  });

  // regression: #16887 onboarding Continue locked up on computers that won't connect
  it("is not ready without a connected selection", () => {
    expect(resolveOnboardingSetup([local], new Set()).ready).toBe(false);
    expect(
      resolveOnboardingSetup([computer("off", "available")], new Set([EnvironmentId.make("off")]))
        .ready,
    ).toBe(false);
  });
});
