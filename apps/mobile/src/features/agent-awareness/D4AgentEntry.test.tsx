import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import {
  D4AgentError,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ThreadId,
} from "@d4research/contracts";
import { D4AgentEntry } from "./D4Agent";

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  navigate: vi.fn(),
  resetNavigation: vi.fn(),
  enabled: true,
  shellReady: true,
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => children,
  Pressable: ({
    children,
    disabled,
    onPress,
  }: {
    children?: ReactNode;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  ScrollView: () => null,
  TextInput: () => null,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@d4research/client-runtime/state/server", async () => {
  const Effect = await import("effect/Effect");
  return { waitForD4AgentThreadShell: () => Effect.succeed(mocks.shellReady) };
});
vi.mock("../../state/environments", () => ({
  useEnvironmentConnectionState: () => ({ data: { phase: "connected" } }),
}));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { threadShellAtom: () => "shell" },
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { ensureD4AgentThread: { permissionAtom: () => "permission" } },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.resolve }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));
vi.mock("../../state/entities", () => ({
  useProject: () => null,
  useEnvironmentServerConfig: () => ({
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      d4Agent: { ...DEFAULT_SERVER_SETTINGS.d4Agent, enabled: mocks.enabled },
    },
  }),
}));
vi.mock("./useD4AgentState", () => ({ useD4AgentState: () => ({ data: null }) }));
vi.mock("@react-navigation/native", () => ({
  useLinkTo: () => mocks.navigate,
  useNavigation: () => ({
    getParent: () => undefined,
    getState: () => ({ key: "root", index: 0, routes: [{ name: "Home" }] }),
    dispatch: mocks.resetNavigation,
  }),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));

let root: Root;
let container: HTMLDivElement;
const environmentId = EnvironmentId.make("test-environment");
const threadId = ThreadId.make("agent-thread");
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.resolve.mockReset().mockResolvedValue({ _tag: "Success", value: { threadId } });
  mocks.resetNavigation.mockClear();
  mocks.navigate.mockClear();
  mocks.enabled = true;
  mocks.shellReady = true;
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("opens the Settings tab when Nia is disabled without trying to launch it", async () => {
  mocks.enabled = false;
  await act(() => root.render(<D4AgentEntry environmentId={environmentId} />));
  await act(async () => container.querySelector("button")!.click());
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.resetNavigation).toHaveBeenCalledWith({
    type: "RESET",
    target: "root",
    payload: {
      key: "root",
      index: 2,
      routes: [{ name: "Home" }, { name: "Settings" }, { name: "SettingsThreads" }],
    },
  });
});

it.each([
  ["disabled", "Agent chat is off."],
  ["model-not-selected", "Choose an agent model"],
  ["provider-unavailable", "The selected provider is unavailable."],
  ["model-unavailable", "The selected model is unavailable."],
] as const)("reports the actual %s launch failure and offers settings", async (reason, message) => {
  mocks.resolve.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new D4AgentError({ reason })),
  } as never);
  await act(() => root.render(<D4AgentEntry environmentId={environmentId} />));
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain(message);
  expect(container.textContent).not.toContain("Check that it is enabled");
  expect(mocks.navigate).not.toHaveBeenCalled();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "Settings")!
      .click(),
  );
  expect(mocks.resetNavigation).toHaveBeenCalledOnce();
});

it("does not report Nia as disabled when its thread has not arrived and allows retry", async () => {
  mocks.shellReady = false;
  await act(() => root.render(<D4AgentEntry environmentId={environmentId} />));
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("Could not open Nia. Try again.");
  expect(container.textContent).not.toContain("enabled");
  expect(mocks.navigate).not.toHaveBeenCalled();
  mocks.shellReady = true;
  await act(async () => container.querySelector("button")!.click());
  expect(mocks.navigate).toHaveBeenCalledWith(`/threads/${environmentId}/${threadId}`);
  expect(container.textContent).not.toContain("Could not open Nia");
});

it("keeps an unexpected launch failure retryable without claiming Nia is disabled", async () => {
  mocks.resolve.mockRejectedValueOnce(new Error("connection closed"));
  await act(() => root.render(<D4AgentEntry environmentId={environmentId} />));
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("Could not open Nia. Try again.");
  expect(mocks.navigate).not.toHaveBeenCalled();
  await act(async () => container.querySelector("button")!.click());
  expect(mocks.navigate).toHaveBeenCalledWith(`/threads/${environmentId}/${threadId}`);
});
