import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, type D4AgentState } from "@d4research/contracts";
import { NiaRoutines } from "./NiaRoutines";

const mocks = vi.hoisted(() => ({
  allowed: true,
  connected: true,
  toggle: vi.fn(async (_input: unknown) => ({ _tag: "Success" })),
  send: vi.fn(async (_input: unknown) => ({ _tag: "Success" })),
  defaultWorker: { instanceId: "codex", model: "gpt-default" },
  explicitWorker: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "config"
      ? {
          settings: {
            d4Agent: {
              projectContexts: {},
              taskModelSelection: mocks.defaultWorker,
            },
          },
        }
      : mocks.allowed,
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: mocks.connected ? "connected" : "disconnected" } }),
  useEnvironmentProviders: () => new Map([["env:synthetic", []]]),
}));
vi.mock("../../hooks/useSettings", () => ({
  useMergedSettings: (settings: unknown) => settings,
}));
vi.mock("../../providerInstances", () => ({
  deriveProviderInstanceEntries: () => [],
  applyProviderInstanceSettings: (entries: unknown) => entries,
  sortProviderInstanceEntries: (entries: unknown) => entries,
  providerInstanceEntriesFor: () => [],
}));
vi.mock("../../modelSelection", () => ({
  resolveAppModelSelectionState: () => mocks.defaultWorker,
  getCustomModelOptionsByInstance: () => new Map(),
}));
vi.mock("../../state/server", () => ({
  EMPTY_SERVER_PROVIDERS: [],
  serverEnvironment: {
    configValueAtom: () => "config",
    scheduledTasksLive: () => "tasks",
    setScheduledTaskEnabled: { permissionAtom: () => "allowed", kind: "toggle" },
    sendD4AgentMessage: { permissionAtom: () => "allowed", kind: "send" },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { kind: string }) =>
    command.kind === "toggle" ? mocks.toggle : mocks.send,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      tasks: [
        {
          id: "job:synthetic",
          title: "Example routine",
          projectId: "project:synthetic",
          enabled: true,
          schedule: { type: "interval", everyMs: 60000 },
          nextRunAt: null,
          lastRunAt: null,
          lastRunStatus: "never",
          lastRunThreadId: "thread:synthetic",
        },
      ],
    },
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params }: { children: ReactNode; params: { threadId: string } }) => (
    <a href={`#${params.threadId}`}>{children}</a>
  ),
}));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    render,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children: ReactNode;
    render?: ReactElement<{ children?: ReactNode }>;
    variant?: string;
    size?: string;
  }) => (render ? cloneElement(render, {}, children) : <button {...props}>{children}</button>),
}));
vi.mock("../ui/sheet", () => ({
  Sheet: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div>{children}</div> : null,
  SheetPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));
vi.mock("../settings/settingsLayout", () => ({
  SettingsSection: ({
    children,
    title,
    hideTitle,
  }: {
    children: ReactNode;
    title: string;
    hideTitle?: boolean;
  }) => (
    <section>
      {hideTitle ? null : <h2>{title}</h2>}
      {children}
    </section>
  ),
  SettingsRow: ({
    children,
    control,
    description,
    title,
    ...props
  }: {
    children?: ReactNode;
    control?: ReactNode;
    description?: ReactNode;
    title: ReactNode;
  } & React.ComponentProps<"div">) => (
    <div {...props}>
      <div>{title}</div>
      {description ? <p>{description}</p> : null}
      {control}
      {children}
    </div>
  ),
}));
vi.mock("../chat/ProviderModelPicker", () => ({
  ProviderModelPicker: ({
    onInstanceModelChange,
  }: {
    onInstanceModelChange: (instanceId: string, model: string) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onInstanceModelChange(mocks.explicitWorker.instanceId, mocks.explicitWorker.model)
      }
    >
      Worker picker
    </button>
  ),
}));

let host: HTMLDivElement;
let root: Root;
const state = {
  brainContext: "Global",
  threadId: "nia:synthetic",
  routines: [],
} as unknown as D4AgentState;
beforeEach(() => {
  mocks.allowed = true;
  mocks.connected = true;
  mocks.toggle.mockClear();
  mocks.send.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function open(inputState = state) {
  await act(async () =>
    root.render(
      <NiaRoutines environmentId={EnvironmentId.make("env:synthetic")} state={inputState} />,
    ),
  );
  await act(async () =>
    (host.querySelector('[aria-label="Open routines"]') as HTMLButtonElement).click(),
  );
}
function button(text: string) {
  return [...host.querySelectorAll("button")].find((node) => node.textContent === text)!;
}
it("lists status, next run and latest execution link; disables the exact selected job", async () => {
  await open();
  expect(host.textContent).toContain("Example routine");
  expect(host.textContent).toContain("Next: No next run");
  expect(host.querySelector('a[href="#thread:synthetic"]')).not.toBeNull();
  await act(async () => button("Disable").click());
  expect(mocks.toggle).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env:synthetic",
    input: { id: "job:synthetic", enabled: false },
  });
});
it("keeps read-only access visible while disabling mutations", async () => {
  mocks.allowed = false;
  await open();
  expect(button("Disable").disabled).toBe(true);
  expect(button("Prepare job").disabled).toBe(true);
  expect(host.textContent).toContain("Read-only access");
  expect(mocks.toggle).not.toHaveBeenCalled();
});
it("does not expose cached rows while disconnected", async () => {
  mocks.connected = false;
  await open();
  expect(host.textContent).toContain("Connect to view routines.");
  expect(host.textContent).not.toContain("Example routine");
});

it("preserves the brief after failure and retries in the bound session", async () => {
  mocks.send.mockResolvedValueOnce({ _tag: "Failure" });
  await open();
  await act(async () => button("Worker picker").click());
  const input = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      "Check example releases every morning",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("Prepare job").click());
  expect(input.value).toBe("Check example releases every morning");
  expect(host.textContent).toContain("Your brief is preserved.");
  await act(async () => button("Prepare job").click());
  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(mocks.send.mock.calls[1]![0]).toMatchObject({
    environmentId: "env:synthetic",
    input: {
      expectedContext: "Global",
      expectedThreadId: "nia:synthetic",
      followUpBehavior: "queue",
      taskModelSelection: mocks.explicitWorker,
    },
  });
  expect(input.value).toBe("");
});

it("does not send duplicate preparation requests while one is in flight", async () => {
  let finish!: (value: { _tag: string }) => void;
  mocks.send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await open();
  const input = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      "Prepare example job",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    const form = host.querySelector("form")!;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(mocks.send).toHaveBeenCalledTimes(1);
  await act(async () => finish({ _tag: "Success" }));
});

it("shows host inventory as dated read-only snapshots", async () => {
  await open({
    ...state,
    hostRoutines: {
      status: "available",
      routines: [
        {
          id: "host:example",
          title: "Example host timer",
          context: "Global",
          source: "systemd",
          schedule: "Daily at 09:00",
          timeZone: "UTC",
          enabled: true,
          nextRunAt: null,
          lastRunAt: null,
          lastRunStatus: "success",
          observedAt: "2026-01-01T00:00:00Z",
          capability: "read-only",
        },
      ],
    },
  });
  const heading = [...host.querySelectorAll("h2")].find(
    (candidate) => candidate.textContent === "Host routines",
  );
  const region = heading?.closest("section") ?? null;
  expect(region).not.toBeNull();
  if (!region) return;
  expect(region.textContent).toContain("Example host timer");
  expect(region.textContent).toContain("Observed:");
  expect(region.querySelectorAll("button").length).toBe(0);
});
