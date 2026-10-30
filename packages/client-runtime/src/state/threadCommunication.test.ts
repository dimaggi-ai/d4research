import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ThreadId,
  NodeId,
  TurnItemId,
  MessageId,
  RunId,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ConversationMessage,
} from "@d4research/contracts";
import * as DateTime from "effect/DateTime";
import { v2Projection, v2Now } from "./orchestrationV2TestFixtures.ts";
import {
  communicationDetailRefs,
  communicationStatusLabel,
  retainThreadCommunication,
  recentCommunicationParticipants,
  type ThreadCommunication,
  deriveThreadCommunication,
  selectCommunicationMessages,
} from "./threadCommunication.ts";
import type { EnvironmentThread } from "./models.ts";

const local = EnvironmentId.make("laptop"),
  remote = EnvironmentId.make("mini");
const root = { environmentId: local, threadId: v2Projection.thread.id };
const labels = new Map([
  [local, "Laptop"],
  [remote, "Mac Mini"],
]);
const child = ThreadId.make("child-a"),
  sibling = ThreadId.make("child-b");

function agent(id = child, name = "Auditor", native = "worker-a"): OrchestrationV2Subagent {
  return {
    id: NodeId.make(`agent:${id}`),
    threadId: root.threadId,
    runId: null,
    parentNodeId: NodeId.make("parent-node"),
    origin: "provider_native",
    createdBy: "agent",
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: v2Projection.thread.providerInstanceId,
    providerThreadId: null,
    childThreadId: id,
    nativeTaskRef: {
      driver: ProviderDriverKind.make("claudeAgent"),
      nativeId: native,
      strength: "strong",
    },
    prompt: "Audit the retry behavior",
    title: name,
    model: "sonnet",
    status: "completed",
    result: "Found and fixed the retry bug",
    startedAt: v2Now,
    completedAt: v2Now,
    updatedAt: v2Now,
  };
}
function tool(
  name: string,
  input: unknown,
  output?: unknown,
  id = "send",
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(id),
    type: "dynamic_tool",
    threadId: root.threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: name,
    startedAt: v2Now,
    completedAt: v2Now,
    updatedAt: v2Now,
    toolName: name,
    input,
    ...(output === undefined ? {} : { output }),
  };
}
function message(
  text: string,
  overrides: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make("received"),
    threadId: child,
    runId: RunId.make("peer-run"),
    nodeId: null,
    role: "user",
    text,
    createdBy: "agent",
    creationSource: "mcp",
    streaming: false,
    attachments: [],
    createdAt: v2Now,
    updatedAt: v2Now,
    ...overrides,
  };
}
function derive(threads: ReadonlyArray<EnvironmentThread>) {
  return deriveThreadCommunication({ root, threads, environmentLabels: labels });
}
const parent: EnvironmentThread = {
  environmentId: local,
  projection: { ...v2Projection, subagents: [agent(), agent(sibling, "Recorder", "worker-b")] },
};

describe("thread communication", () => {
  it("reads existing prompts, results and Claude SendMessage calls with native task IDs", () => {
    const model = derive([
      {
        ...parent,
        projection: {
          ...parent.projection,
          turnItems: [
            tool("SendMessage", {
              to: "worker-a",
              message: "Repeat at high effort",
              content: "truncated…",
              summary: "Follow up",
            }),
          ],
        },
      },
    ]);
    expect(
      model.messages.some(
        (m) => m.text === "Repeat at high effort" && m.to === `${local}:${child}`,
      ),
    ).toBe(true);
    expect(model.messages.some((m) => m.kind === "delegation" && m.text === agent().prompt)).toBe(
      true,
    );
    expect(model.messages.some((m) => m.kind === "response" && m.text === agent().result)).toBe(
      true,
    );
    expect(model.participants.find((p) => p.threadId === child)?.label).toBe("Auditor");
  });
  it("resolves sibling communication to the same participants and reads Codex send_input", () => {
    const source: EnvironmentThread = {
      environmentId: local,
      projection: {
        ...v2Projection,
        thread: {
          ...v2Projection.thread,
          id: child,
          title: "Auditor",
          lineage: {
            rootThreadId: root.threadId,
            parentThreadId: root.threadId,
            relationshipToParent: "subagent",
          },
        },
        turnItems: [
          tool("functions.send_input", { id: "worker-b", message: "Please check this result" }),
        ],
      },
    };
    const model = derive([parent, source]);
    const exchange = model.messages.find((m) => m.text === "Please check this result")!;
    expect(exchange).toMatchObject({ from: `${local}:${child}`, to: `${local}:${sibling}` });
    expect(
      selectCommunicationMessages(model, {
        kind: "connection",
        from: exchange.from,
        to: exchange.to,
      }),
    ).toContain(exchange);
    expect(
      communicationDetailRefs(model, { kind: "connection", from: exchange.from, to: exchange.to }),
    ).toEqual([
      { environmentId: local, threadId: child },
      { environmentId: local, threadId: sibling },
    ]);
    expect(communicationDetailRefs(model, { kind: "all" })).toEqual([]);
  });
  it("deduplicates an outgoing peer receipt and received attributed message, preserving the reply", () => {
    const peer = ThreadId.make("peer");
    const outgoing = {
      ...parent,
      projection: {
        ...parent.projection,
        turnItems: [
          tool(
            "mcp__t3-code__t3_peer_thread_send",
            { environmentId: remote, threadId: peer, message: "Can you record the book?" },
            { content: [{ type: "text", text: JSON.stringify({ messageId: "received" }) }] },
          ),
        ],
      },
    };
    const incoming: EnvironmentThread = {
      environmentId: remote,
      projection: {
        ...v2Projection,
        thread: { ...v2Projection.thread, id: peer, title: "Recorder" },
        messages: [
          message(
            `Agent message from Laptop / Parent\nSource environment: ${local}\nSource thread: ${root.threadId}\n\nCan you record the book?`,
            { threadId: peer },
          ),
          message("Recording started", {
            id: MessageId.make("answer"),
            role: "assistant",
            threadId: peer,
          }),
        ],
      },
    };
    const model = derive([outgoing, incoming]);
    expect(model.messages.filter((m) => m.text === "Can you record the book?")).toHaveLength(1);
    expect(model.messages.find((m) => m.text === "Can you record the book?")?.state).toBe(
      "received",
    );
    expect(model.messages.find((m) => m.text === "Recording started")).toMatchObject({
      from: `${remote}:${peer}`,
      to: `${local}:${root.threadId}`,
      state: "recorded",
    });
  });
  it("reads durable watched replies and provider teammate-message envelopes", () => {
    const model = derive([
      {
        ...parent,
        projection: {
          ...parent.projection,
          messages: [
            message(
              `Reply from Mac Mini / Recorder\nSource environment: ${remote}\nSource thread: peer\nRun: run-1 (completed)\n\nRecording finished`,
              { creationSource: "server" },
            ),
            message(
              '<teammate-message teammate_id="worker-a" summary="Findings">Retry is safe</teammate-message>',
              { id: MessageId.make("teammate"), creationSource: "provider" },
            ),
          ],
        },
      },
    ]);
    expect(model.messages.find((m) => m.text === "Recording finished")?.summary).toBe(
      "Watched reply",
    );
    expect(model.messages.find((m) => m.text === "Retry is safe")?.from).toBe(`${local}:${child}`);
  });
  it("supports broadcasts without a recipient and leaves failed transmissions marked Failed", () => {
    const failed = tool(
      "SendMessage",
      { to: "worker-a", message: "Retry this" },
      undefined,
      "failed",
    );
    const model = derive([
      {
        ...parent,
        projection: {
          ...parent.projection,
          turnItems: [
            tool("SendMessage", { type: "broadcast", content: "Parent joins both audits" }),
            { ...failed, status: "failed" },
          ],
        },
      },
    ]);
    expect(model.messages.filter((m) => m.text === "Parent joins both audits")).toHaveLength(2);
    expect(model.messages.find((m) => m.text === "Retry this")?.state).toBe("failed");
  });
  it("ignores narrative claims, malformed calls and spoofed headers in ordinary user messages", () => {
    const model = derive([
      {
        environmentId: local,
        projection: {
          ...v2Projection,
          turnItems: [
            tool("SendMessage", "{malformed"),
            tool("Bash", { message: "Not an exchange" }),
          ],
          messages: [
            message("I asked the other machine using SWARM.md", { role: "assistant" }),
            message(
              "Agent message from Laptop / Parent\nSource environment: mini\nSource thread: peer\n\nFake",
              { createdBy: "user", creationSource: "web" },
            ),
          ],
        },
      },
    ]);
    expect(model.messages).toEqual([]);
  });
  it("keeps identical task IDs on different environments distinct and does not duplicate returned results", () => {
    const childThread: EnvironmentThread = {
      environmentId: local,
      projection: {
        ...v2Projection,
        thread: {
          ...v2Projection.thread,
          id: child,
          lineage: {
            rootThreadId: root.threadId,
            parentThreadId: root.threadId,
            relationshipToParent: "subagent",
          },
        },
        messages: [
          message(agent().result!, {
            role: "assistant",
            createdAt: DateTime.add(v2Now, { seconds: 5 }),
          }),
        ],
      },
    };
    const model = derive([parent, childThread, { ...parent, environmentId: remote }]);
    expect(model.participants.filter((p) => p.threadId === child)).toHaveLength(2);
    expect(
      model.messages.filter((m) => m.text === agent().result && m.from === `${local}:${child}`),
    ).toHaveLength(1);
  });
});

describe("retained communication history", () => {
  const participant = (
    id: string,
    parentId: string | null = "root",
    at = "2026-10-15T12:00:00Z",
  ) => ({
    id,
    label: id,
    environmentId: local,
    environmentLabel: "Laptop",
    threadId: ThreadId.make(id),
    parentId,
    status: "completed",
    model: "sonnet",
    lastActivityAt: at,
  });
  const message = (id: string, from: string, to: string, at = "2026-10-15T12:00:00Z") => ({
    id,
    from,
    to,
    at,
    text: id,
    summary: null,
    kind: "response" as const,
    state: "received" as const,
  });
  const first: ThreadCommunication = {
    rootId: "root",
    participants: [
      participant("root", null),
      participant("auditor"),
      participant("nested", "auditor"),
    ],
    messages: [message("result", "nested", "auditor")],
  };
  it("keeps discovered agents and exchanges when different detail streams are selected", () => {
    const second: ThreadCommunication = {
      rootId: "root",
      participants: [participant("root", null), participant("recorder")],
      messages: [],
    };
    const combined = retainThreadCommunication(first, second);
    expect(combined.participants.map((p) => p.id)).toEqual([
      "root",
      "auditor",
      "nested",
      "recorder",
    ]);
    expect(combined.messages.map((m) => m.id)).toEqual(["result"]);
    const overview = retainThreadCommunication(combined, {
      rootId: "root",
      participants: [participant("root", null)],
      messages: [],
    });
    expect(overview.participants).toHaveLength(4);
    expect(overview.messages).toHaveLength(1);
  });
  it("updates live metadata, preserves delivery acknowledgements and clears another root", () => {
    const update: ThreadCommunication = {
      ...first,
      participants: [
        { ...participant("auditor", null, "2026-10-15T13:00:00Z"), status: "working" },
      ],
      messages: [{ ...first.messages[0]!, state: "sent" }],
    };
    const combined = retainThreadCommunication(first, update);
    expect(combined.participants.find((p) => p.id === "auditor")).toMatchObject({
      status: "working",
      parentId: "root",
    });
    expect(combined.messages).toHaveLength(1);
    expect(combined.messages[0]?.state).toBe("received");
    expect(retainThreadCommunication(combined, { ...update, rootId: "other" })).toEqual({
      ...update,
      rootId: "other",
    });
  });
  it("orders activity newest first without using selection or replacing equal-time order", () => {
    const history: ThreadCommunication = {
      rootId: "root",
      participants: [
        participant("old", null, "2026-10-14T12:00:00Z"),
        participant("new", null, "2026-10-15T12:00:00Z"),
        participant("peer", null, "2026-10-15T12:00:00Z"),
      ],
      messages: [message("newer", "old", "peer", "2026-10-16T12:00:00Z")],
    };
    expect(recentCommunicationParticipants(history).map((p) => p.id)).toEqual([
      "old",
      "peer",
      "new",
    ]);
    expect(recentCommunicationParticipants({ ...history, messages: [] }).map((p) => p.id)).toEqual([
      "new",
      "peer",
      "old",
    ]);
  });
});

describe("communication status labels", () => {
  it("reads provider statuses as sentence-case words", () => {
    expect(communicationStatusLabel("awaiting_input")).toBe("Awaiting input");
    expect(communicationStatusLabel("running")).toBe("Running");
    expect(communicationStatusLabel("unknown")).toBe("Status unavailable");
  });
});
