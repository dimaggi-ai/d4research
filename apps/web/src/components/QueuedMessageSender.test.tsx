import { scopeThreadRef, scopedThreadKey } from "@d4research/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@d4research/contracts";
import * as Cause from "effect/Cause";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DEFAULT_CLIENT_SETTINGS } from "@d4research/contracts/settings";

import { __setClientSettingsForTests } from "../hooks/useSettings";
import { useQueuedMessageStore, type QueuedComposerMessage } from "../queuedMessageStore";
import { sendQueuedMessage } from "./chat/sendQueuedMessage";
import { QueuedMessageSender } from "./QueuedMessageSender";

const io = vi.hoisted(() => ({
  run: vi.fn(),
  upload: vi.fn(),
  toast: vi.fn(),
  thread: null as unknown,
  shell: { runtimeMode: "full-access", interactionMode: "default" } as Record<string, unknown>,
  providers: [] as unknown[],
}));
const config = {
  environment: { capabilities: { attachmentUploads: true, inlineMessageContext: true } },
  get providers() {
    return io.providers;
  },
};
vi.mock("@d4research/client-runtime/state/runtime", async (load) => ({
  ...(await load<typeof import("@d4research/client-runtime/state/runtime")>()),
  runAtomCommand: (...args: unknown[]) => io.run(...args),
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) => (atom === "settings" ? undefined : new Map([["env-a", config]])),
  },
}));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: {},
  serverEnvironment: { settingsValueAtom: () => "settings" },
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: {
    updateMetadata: "metadata",
    setRuntimeMode: "runtime",
    setInteractionMode: "interaction",
    startTurn: "start",
  },
}));
vi.mock("../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: "connected" } }),
}));
vi.mock("../state/entities", () => ({
  useThread: () => io.thread,
  useThreadStatus: () => "live",
  useServerConfigs: () => new Map([["env-a", config]]),
  readThreadShell: () => io.shell,
  readThread: () => io.thread,
  readProject: () => ({ title: "Project A" }),
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: (...args: unknown[]) => io.toast(...args) } }));
vi.mock("../lib/attachmentUploadQueue", () => ({
  startAttachmentUpload: vi.fn(),
  awaitAttachmentUploads: (...args: unknown[]) => io.upload(...args),
  getUploadedAttachments: () => [
    { type: "image", id: "uploaded", name: "a.png", mimeType: "image/png", sizeBytes: 4 },
  ],
  releaseDraftAttachments: vi.fn(),
}));

const threadRef = scopeThreadRef(EnvironmentId.make("env-a"), ThreadId.make("thread-a"));
const threadKey = scopedThreadKey(threadRef);
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

function enqueue(overrides: Partial<QueuedComposerMessage> = {}) {
  return useQueuedMessageStore.getState().enqueue(threadKey, {
    prompt: "follow up",
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    sendSettings: {
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      promptEffort: null,
    },
    queuedAfterToolActivityId: null,
    createdAt: "2026-09-25T00:00:00Z",
    ...overrides,
  });
}

const commandsRun = () => io.run.mock.calls.map((call) => call[1]);
const queue = () => useQueuedMessageStore.getState().queuesByThreadKey[threadKey];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, followUpBehavior: "queue" });
  useQueuedMessageStore.setState({ queuesByThreadKey: {}, lastDispatchByThreadKey: {} });
  io.thread = null;
  io.providers = [];
  io.run.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  io.upload.mockReset().mockResolvedValue(undefined);
  io.toast.mockReset();
  io.shell = {
    modelSelection,
    branch: null,
    runtimeMode: "full-access",
    interactionMode: "default",
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("QueuedMessageSender", () => {
  const thread = (
    status: string,
    {
      toolActivityIds = [] as string[],
      userMessageIds = [] as string[],
      providerName = null as string | null,
    } = {},
  ) => ({
    modelSelection,
    session: { status, providerName, activeTurnId: null, updatedAt: status },
    activities: toolActivityIds.map((id, index) => ({
      id,
      kind: "tool.completed",
      sequence: index,
      createdAt: "2026-09-25T00:00:01Z",
    })),
    messages: userMessageIds.map((id) => ({ id, role: "user" })),
    latestTurn: null,
  });
  let root: ReactTestRenderer | null = null;
  const render = () =>
    act(() => {
      if (root) root.update(createElement(QueuedMessageSender));
      else root = create(createElement(QueuedMessageSender));
    });
  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
  });

  it("sends a queued message when the turn ends, with no chat view open", async () => {
    enqueue();
    io.thread = thread("running");
    await render();
    expect(commandsRun()).toEqual([]);

    io.thread = thread("ready");
    await render();

    expect(commandsRun()).toEqual(["start"]);
    expect(io.run.mock.calls[0]?.[2]).toMatchObject({
      environmentId: "env-a",
      input: { threadId: "thread-a", message: { text: "follow up" }, modelSelection },
    });
    expect(queue()).toBeUndefined();
  });

  it("holds the next message until the server picks up the one before it", async () => {
    enqueue({ prompt: "first" });
    enqueue({ prompt: "second" });
    io.thread = thread("ready");
    await render();
    await render();
    expect(commandsRun()).toEqual(["start"]);

    // The first message started a turn; the second waits for its next tool call.
    io.thread = thread("running", { userMessageIds: ["first"] });
    await render();
    expect(commandsRun()).toEqual(["start"]);
    io.thread = thread("running", { userMessageIds: ["first"], toolActivityIds: ["tool-1"] });
    await render();
    expect(commandsRun()).toEqual(["start", "start"]);
  });

  it.each([
    ["the user chose to wait for the turn to end", "wait", null],
    ["the provider cannot take a second turn while one runs", "steer", "muse"],
  ] as const)("holds a message through tool calls when %s", async (_, behavior, providerName) => {
    __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, followUpBehavior: behavior });
    enqueue();
    io.thread = thread("running", { toolActivityIds: ["tool-1"], providerName });
    await render();
    expect(commandsRun()).toEqual([]);

    io.thread = thread("ready", { toolActivityIds: ["tool-1"], providerName });
    await render();
    expect(commandsRun()).toEqual(["start"]);
  });

  it("moves on to the next message after a failed one is cancelled", async () => {
    io.run.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("offline")) });
    const first = enqueue({ prompt: "first" });
    enqueue({ prompt: "second" });
    io.thread = thread("ready");
    await render();
    expect(queue()?.[0]).toMatchObject({ prompt: "first", holdUntilUserAction: true });

    await act(() => {
      useQueuedMessageStore.getState().remove(threadKey, first.id);
    });
    await render();

    expect(commandsRun()).toEqual(["start", "start"]);
    expect(io.run.mock.calls[1]?.[2]).toMatchObject({ input: { message: { text: "second" } } });
  });
});

describe("sendQueuedMessage", () => {
  it("saves a mode changed before queueing, then starts the turn", async () => {
    io.shell = { ...io.shell, runtimeMode: "approval-required" };
    const message = enqueue();

    await sendQueuedMessage(threadRef, message.id);

    expect(commandsRun()).toEqual(["runtime", "start"]);
    expect(io.run.mock.calls[1]?.[2]).toMatchObject({ input: { runtimeMode: "full-access" } });
    expect(queue()).toBeUndefined();
  });

  it("gives a message back to Stop while its upload runs, without starting a turn", async () => {
    let finishUpload!: () => void;
    io.upload.mockReturnValue(new Promise<void>((resolve) => (finishUpload = resolve)));
    const image = {
      type: "image" as const,
      id: "image-1",
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 4,
      previewUrl: "data:image/png;base64,AAAA",
      file: new File(["AAAA"], "a.png", { type: "image/png" }),
    };
    const message = enqueue({ images: [image] });

    const sending = sendQueuedMessage(threadRef, message.id);
    expect(useQueuedMessageStore.getState().drain(threadKey)).toHaveLength(1);
    finishUpload();
    await sending;

    expect(commandsRun()).toEqual([]);
    expect(io.toast).not.toHaveBeenCalled();
    expect(queue()).toBeUndefined();
  });

  it("holds a message at the head when the turn start fails", async () => {
    io.run.mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("offline")) });
    enqueue({ prompt: "first" });
    const second = enqueue({ prompt: "second" });

    await sendQueuedMessage(threadRef, second.id);

    expect(queue()?.map((entry) => [entry.prompt, entry.holdUntilUserAction])).toEqual([
      ["second", true],
      ["first", undefined],
    ]);
    expect(io.toast).toHaveBeenCalledWith(expect.objectContaining({ description: "offline" }));
  });
});

describe("sendQueuedMessage provider handoff", () => {
  const provider = (driver: string, overrides: Record<string, unknown> = {}) => ({
    driver,
    instanceId: driver,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    version: null,
    checkedAt: "2026-09-25T00:00:00Z",
    models: [{ slug: "model-a", name: "Model A", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    ...overrides,
  });
  const claudeSelection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "model-a" };

  beforeEach(() => {
    io.thread = {
      id: "thread-a",
      projectId: "project-a",
      title: "Thread A",
      modelSelection,
      session: {
        status: "ready",
        providerName: "codex",
        providerInstanceId: "codex",
        activeTurnId: null,
        updatedAt: "2026-09-25T00:00:00Z",
      },
      messages: [
        { id: "m1", role: "user", text: "original task" },
        { id: "m2", role: "assistant", text: "latest finding" },
      ],
      activities: [],
      latestTurn: null,
    };
  });

  const enqueueFor = (selection: typeof claudeSelection, prompt = "follow up") =>
    enqueue({
      prompt,
      sendSettings: {
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        promptEffort: null,
      },
    });

  it("carries the thread's context to a provider staged when the message was queued", async () => {
    io.providers = [provider("codex"), provider("claudeAgent")];
    const message = enqueueFor(claudeSelection);

    await sendQueuedMessage(threadRef, message.id);

    // The model changes only with the handoff turn, never in a plain metadata update.
    expect(commandsRun()).toEqual(["start"]);
    const input = io.run.mock.calls[0]?.[2].input;
    expect(input.modelSelection).toEqual(claudeSelection);
    expect(input.message.text).toContain("follow up");
    expect(input.message.text).toContain("original task");
    expect(input.message.text).toContain("latest finding");
    expect(queue()).toBeUndefined();
  });

  it("holds the message instead of switching to an unavailable provider", async () => {
    io.providers = [provider("codex"), provider("claudeAgent", { status: "error" })];
    const message = enqueueFor(claudeSelection);

    await sendQueuedMessage(threadRef, message.id);

    expect(commandsRun()).toEqual([]);
    expect(queue()?.[0]).toMatchObject({ id: message.id, holdUntilUserAction: true });
    expect(io.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Claude is not available to receive a handoff.",
      }),
    );
  });

  it("never hands off a delegation or moves the thread's model for it", async () => {
    io.providers = [provider("codex"), provider("claudeAgent")];
    const message = enqueueFor(claudeSelection, "!gemini:pro check the numbers");

    await sendQueuedMessage(threadRef, message.id);

    expect(commandsRun()).toEqual(["start"]);
    const input = io.run.mock.calls[0]?.[2].input;
    expect(input.message.text).toBe("!gemini:pro check the numbers");
    expect(input).not.toHaveProperty("modelSelection");
  });

  it("sends a message on the running provider without handoff context", async () => {
    io.providers = [provider("codex"), provider("claudeAgent")];
    const message = enqueueFor(modelSelection);

    await sendQueuedMessage(threadRef, message.id);

    expect(io.run.mock.calls[0]?.[2].input.message.text).toBe("follow up");
  });
});
