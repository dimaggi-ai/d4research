import { RegistryContext } from "@effect/atom-react";
import {
  AuthSessionState,
  type BundledServerRuntime,
  type EnvironmentId,
} from "@d4research/contracts";
import type { EnvironmentPresentation } from "~/state/environments";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../test/render";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  toast: vi.fn(),
  clipboard: vi.fn(),
  sessionAtom: null as unknown,
  serverVersions: new Map<string, string>(),
  environment: null as EnvironmentPresentation | null,
  runtime: null as BundledServerRuntime | null,
}));

vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: () => testState.environment,
  useEnvironments: () => ({
    isReady: true,
    networkStatus: "online",
    presentationById: new Map(),
    environments: testState.environment ? [testState.environment] : [],
  }),
}));
vi.mock(import("~/state/desktopUpdate"), async (original) => ({
  ...(await original()),
  useBundledServerRuntime: () => testState.runtime,
}));

vi.mock(import("~/hooks/useCopyToClipboard"), async (original) => ({
  ...(await original()),
  useCopyToClipboard: ((options: { onCopy: (context: { command: string }) => void }) => ({
    copyToClipboard: (command: string, context: { command: string }) => {
      testState.clipboard(command);
      options.onCopy(context);
    },
    isCopied: false,
  })) as never,
}));
vi.mock(import("~/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSession: {
      ...actual.environmentSession,
      sessionStateAtom: (() => testState.sessionAtom) as never,
    },
  };
});
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() =>
    new Map(
      [...testState.serverVersions].map(([id, serverVersion]) => [
        id,
        { environment: { serverVersion } },
      ]),
    )) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => testState.updateServer) as never,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: testState.toast } };
});

import { resetConfirmDialogForTests } from "~/confirmDialog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  ServerUpdateAction,
  ServerUpdatesAction,
  type ServerUpdateTarget,
} from "./ServerUpdateAction";

const decodeSessionState = Schema.decodeUnknownSync(AuthSessionState);

const legacyAuth = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "t3_session",
} as const;

const currentSession = {
  authenticated: true,
  scopes: ["environment:maintain"],
  auth: {
    ...legacyAuth,
    serverUpdateScope: "environment:maintain",
  },
} as const satisfies AuthSessionState;

const success = (method: "boot-service" | "desktop-app" = "boot-service", version = "0.0.31") =>
  AsyncResult.success({ targetVersion: version, method });

function setSession(session: SessionResult) {
  appAtomRegistry.set(testState.sessionAtom as Atom.Writable<SessionResult>, session);
}

function setup(): Disposable {
  testState.updateServer.mockReset();
  testState.toast.mockReset();
  testState.clipboard.mockReset();
  testState.serverVersions.clear();
  testState.environment = null;
  testState.runtime = null;
  const sessionAtom = Atom.make<SessionResult>(AsyncResult.success(currentSession));
  testState.sessionAtom = sessionAtom;
  resetConfirmDialogForTests();
  return { [Symbol.dispose]: resetConfirmDialogForTests };
}

function renderUpdate(element: ReactNode) {
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>{element}</RegistryContext.Provider>,
  );
}

function button(screen: Screen, name?: string) {
  const buttons = [...screen.container.querySelectorAll("button")];
  return name === undefined
    ? buttons[0]
    : buttons.find((element) => element.textContent?.trim() === name);
}

async function click(screen: Screen, name?: string) {
  await act(async () => button(screen, name)!.click());
}

function renderAction(props: Partial<Parameters<typeof ServerUpdateAction>[0]> = {}) {
  return renderUpdate(
    <ServerUpdateAction
      environmentId={"env-test" as EnvironmentId}
      serverLabel="Test server"
      selfUpdate="boot-service"
      targetVersion="0.0.31"
      {...props}
    />,
  );
}

describe("ServerUpdateAction", () => {
  it.each([
    { serverUpdateScope: undefined, scopes: ["orchestration:operate"], allowed: true },
    { serverUpdateScope: undefined, scopes: ["orchestration:read"], allowed: false },
    {
      serverUpdateScope: "environment:maintain",
      scopes: ["orchestration:operate"],
      allowed: false,
    },
    {
      serverUpdateScope: "environment:maintain",
      scopes: ["environment:maintain"],
      allowed: true,
    },
  ] as const)(
    "uses the advertised update scope $serverUpdateScope with grant $scopes",
    async ({ serverUpdateScope, scopes, allowed }) => {
      using _state = setup();
      setSession(
        AsyncResult.success(
          decodeSessionState({
            ...currentSession,
            scopes,
            auth: {
              ...legacyAuth,
              ...(serverUpdateScope === undefined ? {} : { serverUpdateScope }),
            },
          }),
        ),
      );
      testState.updateServer.mockResolvedValue(success());

      await using screen = await renderAction();
      expect(button(screen, "Update")!.disabled).toBe(!allowed);
      await click(screen, "Update");

      expect(testState.updateServer).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it("disables the action once maintenance access is removed", async () => {
    using _state = setup();
    await using screen = await renderAction();
    await act(() => setSession(AsyncResult.success({ ...currentSession, scopes: [] })));
    expect(button(screen, "Update")!.disabled).toBe(true);
    await click(screen, "Update");
    expect(testState.updateServer).not.toHaveBeenCalled();
  });
});

describe("ServerUpdatesAction", () => {
  const targets: ReadonlyArray<ServerUpdateTarget> = [
    {
      environmentId: "batch-a" as EnvironmentId,
      serverLabel: "Laptop",
      selfUpdate: "boot-service",
      targetVersion: "0.0.31",
    },
    {
      environmentId: "batch-b" as EnvironmentId,
      serverLabel: "Office",
      selfUpdate: "respawn",
      targetVersion: "0.0.31",
    },
    {
      environmentId: "batch-c" as EnvironmentId,
      serverLabel: "Manual",
      selfUpdate: null,
      targetVersion: "0.0.31",
    },
  ];

  const mount = (batch = targets) => renderUpdate(<ServerUpdatesAction targets={batch} />);

  it("names a failed machine while letting the other machine complete", async () => {
    using _state = setup();
    testState.updateServer
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Download failed"))))
      .mockResolvedValueOnce(success());
    await using screen = await mount();
    await click(screen, "Update all");

    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(testState.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Laptop update failed",
      description: "Download failed",
    });
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Office updated" }),
    );
    expect(button(screen, "Update all")!.disabled).toBe(false);
  });

  it("skips a machine whose update would cross Stable and Nightly", async () => {
    using _state = setup();
    testState.serverVersions.set("batch-a", "0.0.30-nightly.20261001.1");
    testState.updateServer.mockResolvedValue(success());
    await using screen = await mount();
    await click(screen, "Update all");

    expect(testState.updateServer).toHaveBeenCalledTimes(1);
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Office updated" }),
    );
  });
});

describe("bundled fork update", () => {
  it.each([false, true])(
    "selects the intended server build when a runtime is discovered (explicit track: %s)",
    async (explicitTrack) => {
      using _state = setup();
      const runtime = {
        version: "0.1.2",
        buildId: "a".repeat(64),
        sha256: "b".repeat(64),
        os: "darwin" as const,
        arch: "arm64" as const,
      };
      const target = { alias: "mini", hostname: "mini.test", username: "developer", port: 22 };
      testState.runtime = runtime;
      testState.environment = {
        environmentId: "env-test",
        entry: { profile: Option.some({ _tag: "SshConnectionProfile", target }) },
        serverConfig: {
          settings: { continueThreadsAfterServerUpdate: false },
          environment: { platform: { os: "darwin", arch: "arm64" }, serverVersion: "0.1.1" },
        },
      } as EnvironmentPresentation;
      testState.updateServer.mockResolvedValue(AsyncResult.success(runtime));
      const targetVersion = explicitTrack ? "0.1.6-nightly.20261029.4000" : runtime.version;
      await using screen = await renderAction({
        selfUpdate: explicitTrack ? "boot-service" : null,
        targetVersion,
        ...(explicitTrack ? { channel: "nightly", targetDatabaseMigration: 77 } : {}),
      });
      await click(screen);
      expect(testState.clipboard).not.toHaveBeenCalled();
      expect(testState.updateServer).toHaveBeenCalledWith(
        explicitTrack
          ? {
              environmentId: "env-test",
              input: { targetVersion, channel: "nightly", targetDatabaseMigration: 77 },
            }
          : {
              environmentId: "env-test",
              target,
              buildId: runtime.buildId,
              version: runtime.version,
              fromVersion: "0.1.1",
            },
      );
    },
  );
  it("uploads the app's runtime for a managed SSH environment instead of copying a public install command", async () => {
    using _state = setup();
    const runtime = {
      version: "0.1.1",
      buildId: "a".repeat(64),
      os: "darwin" as const,
      arch: "arm64" as const,
      sha256: "b".repeat(64),
    };
    const target = {
      alias: "stepan-mac-mini",
      hostname: "mini.test",
      username: "developer",
      port: 22,
    };
    testState.updateServer.mockResolvedValue(AsyncResult.success(runtime));
    await using screen = await renderAction({
      selfUpdate: null,
      targetVersion: runtime.version,
      bundledRuntime: { runtime, target, fromVersion: "0.1.0" },
    });
    await click(screen, "Update");
    expect(testState.clipboard).not.toHaveBeenCalled();
    expect(testState.updateServer).toHaveBeenCalledWith({
      environmentId: "env-test",
      target,
      buildId: runtime.buildId,
      version: runtime.version,
      fromVersion: "0.1.0",
    });
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Test server updated" }),
    );
  });
});
