import { act, render, stubGlobal } from "../../../test/render";
import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@d4research/contracts";
import type {
  CommunicationSelection,
  ThreadCommunication,
} from "@d4research/client-runtime/state/thread-communication";
import { AgentCommunicationDialog } from "./AgentCommunicationDialog";
import { AgentCommunicationView } from "./AgentCommunicationView";

const env = EnvironmentId.make("local");
const model: ThreadCommunication = {
  rootId: "parent",
  participants: ["parent", "auditor", "recorder"].map((id) => ({
    id,
    label: id === "parent" ? "Lead agent" : id === "auditor" ? "Auditor" : "Recorder",
    environmentId: env,
    environmentLabel: "Laptop",
    threadId: ThreadId.make(id),
    parentId: id === "parent" ? null : "parent",
    status: "completed",
    model: "sonnet",
  })),
  messages: [
    {
      id: "task",
      from: "parent",
      to: "auditor",
      text: "Check the reconnect behavior.",
      summary: "Task assigned",
      kind: "delegation",
      state: "sent",
      at: "2026-10-14T20:00:00Z",
    },
    {
      id: "ask",
      from: "auditor",
      to: "recorder",
      text: "What happens if the connection closes?",
      summary: "Compare findings",
      kind: "message",
      state: "sent",
      at: "2026-10-14T20:01:00Z",
    },
    {
      id: "answer",
      from: "recorder",
      to: "auditor",
      text: "The watch reconnects without duplicate delivery.",
      summary: null,
      kind: "response",
      state: "received",
      at: "2026-10-14T20:02:00Z",
    },
  ],
};
function button(label: string) {
  const matches = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
    (b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label,
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
function Viewer() {
  const [selection, select] = useState<CommunicationSelection>({ kind: "all" });
  return <AgentCommunicationView model={model} selection={selection} onSelect={select} />;
}

describe("communication dialog interactions", () => {
  it("opens from its panel button, filters a sibling connection, hides the map and closes", async () => {
    let shortPhone = false;
    using _viewport = stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: shortPhone,
      addEventListener() {},
      removeEventListener() {},
    }));
    // These dialog fixtures do not navigate.
    await using screen = await render(
      <AgentCommunicationDialog>{() => <Viewer />}</AgentCommunicationDialog>,
      { router: false },
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click("Agent communication");
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    await click("Show map");
    await click("Read connection between Auditor and Recorder");
    const messages = document.querySelector('[aria-label="Messages between agents"]')!;
    expect(messages.textContent).toContain("What happens if the connection closes?");
    expect(messages.textContent).toContain("without duplicate delivery");
    expect(messages.textContent).not.toContain("Check the reconnect behavior.");
    await click("Hide map");
    expect(document.querySelector('[aria-label="Agents in the map"]')).toBeNull();
    await click("Close");
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
  });
  it("receives new exchanges while open, preserves the chosen connection, and releases its viewer on close", async () => {
    let shortPhone = false;
    using _viewport = stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: shortPhone,
      addEventListener() {},
      removeEventListener() {},
    }));
    let mountedViewers = 0;
    let publish: Dispatch<SetStateAction<ThreadCommunication>> | undefined;
    function LiveViewer() {
      const [current, setCurrent] = useState(model);
      const [selection, select] = useState<CommunicationSelection>({ kind: "all" });
      useEffect(() => {
        mountedViewers++;
        publish = setCurrent;
        return () => {
          mountedViewers--;
          publish = undefined;
        };
      }, []);
      return <AgentCommunicationView model={current} selection={selection} onSelect={select} />;
    }
    // These dialog fixtures do not navigate.
    await using screen = await render(
      <AgentCommunicationDialog>{() => <LiveViewer />}</AgentCommunicationDialog>,
      { router: false },
    );
    expect(mountedViewers).toBe(0);
    await click("Agent communication");
    expect(mountedViewers).toBe(1);
    await click("Show map");
    await click("Read connection between Auditor and Recorder");
    await act(async () =>
      publish?.({
        ...model,
        messages: [
          ...model.messages,
          {
            id: "follow-up",
            from: "auditor",
            to: "recorder",
            text: "Confirmed after reconnect.",
            summary: null,
            kind: "message",
            state: "received",
            at: "2026-10-14T20:03:00Z",
          },
        ],
      }),
    );
    const messages = document.querySelector('[aria-label="Messages between agents"]')!;
    expect(messages.textContent).toContain("Confirmed after reconnect.");
    expect(messages.textContent).toContain("What happens if the connection closes?");
    expect(messages.textContent).not.toContain("Check the reconnect behavior.");
    await click("Close");
    await vi.waitFor(() => expect(mountedViewers).toBe(0));
    expect(publish).toBeUndefined();
    await click("Agent communication");
    expect(mountedViewers).toBe(1);
    await click("Close");
    await vi.waitFor(() => expect(mountedViewers).toBe(0));
  });
  it("keeps messages readable on a short phone and lets the user expand its map", async () => {
    let shortPhone = false;
    using _viewport = stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: shortPhone,
      addEventListener() {},
      removeEventListener() {},
    }));
    shortPhone = true;
    // These dialog fixtures do not navigate.
    await using screen = await render(
      <AgentCommunicationDialog>{() => <Viewer />}</AgentCommunicationDialog>,
      { router: false },
    );
    await click("Agent communication");
    expect(document.querySelector('[aria-label="Agents in the map"]')).toBeNull();
    expect(document.querySelector('[aria-label="Messages between agents"]')?.textContent).toContain(
      "Check the reconnect behavior.",
    );
    await click("Show map");
    expect(document.querySelector('[aria-label="Agents in the map"]')).not.toBeNull();
    await click("Hide map");
    expect(document.querySelector('[aria-label="Agents in the map"]')).toBeNull();
  });
  it("opens an empty thread without requiring a setting or an existing exchange", async () => {
    let shortPhone = false;
    using _viewport = stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: shortPhone,
      addEventListener() {},
      removeEventListener() {},
    }));
    // These dialog fixtures do not navigate.
    await using screen = await render(
      <AgentCommunicationDialog>
        {() => (
          <AgentCommunicationView
            model={{ rootId: "parent", participants: [], messages: [] }}
            selection={{ kind: "all" }}
            onSelect={() => {}}
          />
        )}
      </AgentCommunicationDialog>,
      { router: false },
    );
    await click("Agent communication");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "No recorded communication",
    );
  });
  it("keeps every agent in place while selecting cards, connections and the parent", async () => {
    let shortPhone = false;
    using _viewport = stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: shortPhone,
      addEventListener() {},
      removeEventListener() {},
    }));
    const children = Array.from({ length: 9 }, (_, index) => ({
      ...model.participants[1]!,
      id: `child-${index}`,
      label: `Task ${index + 1}`,
      threadId: ThreadId.make(`child-${index}`),
      lastActivityAt: `2026-10-15T10:00:0${9 - index}Z`,
    }));
    const many: ThreadCommunication = {
      ...model,
      participants: [model.participants[0]!, ...children],
      messages: [{ ...model.messages[0]!, to: "child-8" }],
    };
    function ManyAgents() {
      const [selection, select] = useState<CommunicationSelection>({ kind: "all" });
      return <AgentCommunicationView model={many} selection={selection} onSelect={select} />;
    }
    // These dialog fixtures do not navigate.
    await using screen = await render(<ManyAgents />, { router: false });
    const order = () =>
      [...screen.container.querySelectorAll("[data-communication-agent]")].map((element) =>
        element.getAttribute("data-communication-agent"),
      );
    await click("Show map");
    await click("Show all 10 agents");
    const initial = order();
    expect(initial).toEqual(["parent", ...children.map((child) => child.id)]);
    await click("Read exchanges with Task 9");
    expect(order()).toEqual(initial);
    expect(
      screen.container.querySelector('[aria-label="Messages between agents"]')?.textContent,
    ).toContain("Check the reconnect behavior.");
    await click("Read exchanges with Task 2");
    expect(order()).toEqual(initial);
    await click("Read connection between Lead agent and Task 9");
    expect(order()).toEqual(initial);
    await click("Read exchanges with Lead agent");
    expect(order()).toEqual(initial);
    expect(screen.container.querySelector('nav [aria-pressed="true"]')?.textContent).toContain(
      "All conversations",
    );
  });
  it("shows actual nested parentage and separates reply counts from assigned tasks", async () => {
    let shortPhone = false;
    using _viewport = stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: shortPhone,
      addEventListener() {},
      removeEventListener() {},
    }));
    const nested: ThreadCommunication = {
      ...model,
      participants: [
        model.participants[0]!,
        model.participants[1]!,
        { ...model.participants[2]!, parentId: "auditor" },
      ],
      messages: [
        {
          ...model.messages[0]!,
          id: "reply",
          from: "auditor",
          to: "parent",
          kind: "response",
          state: "received",
        },
        model.messages[0]!,
        { ...model.messages[1]!, kind: "delegation" },
        model.messages[2]!,
      ],
    };
    function NestedAgents() {
      const [selection, select] = useState<CommunicationSelection>({ kind: "all" });
      return <AgentCommunicationView model={nested} selection={selection} onSelect={select} />;
    }
    // These dialog fixtures do not navigate.
    await using screen = await render(<NestedAgents />, { router: false });
    await click("Show map");
    const branch = screen.container.querySelector('[aria-label="Tasks delegated by Auditor"]');
    expect(branch?.querySelector('[data-communication-agent="recorder"]')).not.toBeNull();
    expect(button("Read connection between Lead agent and Auditor").textContent).toContain(
      "1 task",
    );
    expect(button("Read connection between Lead agent and Auditor").textContent).toContain(
      "1 reply",
    );
    await click("Read connection between Lead agent and Auditor");
    const messages = screen.container.querySelector('[aria-label="Messages between agents"]');
    expect(messages?.querySelectorAll("article")).toHaveLength(2);
  });
  it("keeps unrelated and cyclic records visible without inventing a coordinator link", async () => {
    let shortPhone = false;
    using _viewport = stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: shortPhone,
      addEventListener() {},
      removeEventListener() {},
    }));
    const inconsistent: ThreadCommunication = {
      ...model,
      participants: [
        model.participants[0]!,
        { ...model.participants[1]!, parentId: "recorder" },
        { ...model.participants[2]!, parentId: "auditor" },
      ],
    };
    // These dialog fixtures do not navigate.
    await using screen = await render(
      <AgentCommunicationView
        model={inconsistent}
        selection={{ kind: "all" }}
        onSelect={() => {}}
      />,
      { router: false },
    );
    await click("Show map");
    expect(screen.container.querySelectorAll("[data-communication-agent]")).toHaveLength(3);
    expect(
      screen.container.querySelector('[aria-label="Tasks delegated by Lead agent"]'),
    ).toBeNull();
    expect(screen.container.textContent).toContain("Other threads");
  });
  it("pages a long task history newest first and loads older exchanges below the latest", async () => {
    let shortPhone = false;
    using _viewport = stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: shortPhone,
      addEventListener() {},
      removeEventListener() {},
    }));
    const tasks = Array.from({ length: 75 }, (_, i) => ({
      ...model.participants[1]!,
      id: `task-${i}`,
      label: `History task ${i}`,
      threadId: ThreadId.make(`task-${i}`),
      lastActivityAt: new Date(Date.UTC(2026, 9, 15, 0, i)).toISOString(),
    }));
    const history: ThreadCommunication = {
      ...model,
      participants: [model.participants[0]!, ...tasks],
      messages: tasks.map((p, i) => ({
        ...model.messages[0]!,
        id: `message-${i}`,
        to: p.id,
        text: `Exchange ${i}`,
        at: p.lastActivityAt,
      })),
    };
    function History() {
      const [selection, select] = useState<CommunicationSelection>({ kind: "all" });
      return <AgentCommunicationView model={history} selection={selection} onSelect={select} />;
    }
    // These dialog fixtures do not navigate.
    await using screen = await render(<History />, { router: false });
    const taskIds = () =>
      [...screen.container.querySelectorAll("nav [data-communication-task]")].map((element) =>
        element.getAttribute("data-communication-task"),
      );
    expect(taskIds()).toHaveLength(50);
    expect(taskIds()[0]).toBe("task-74");
    await click("Show 25 more tasks");
    expect(taskIds()).toHaveLength(75);
    expect(taskIds().at(-1)).toBe("task-0");
    const feed = screen.container.querySelector('[aria-label="Messages between agents"]')!;
    expect(feed.querySelectorAll("article")).toHaveLength(30);
    expect(feed.querySelector("article")?.textContent).toContain("Exchange 74");
    await click("Show 30 older messages");
    expect(feed.querySelectorAll("article")).toHaveLength(60);
    expect(feed.querySelector("article")?.textContent).toContain("Exchange 74");
    expect(screen.container.querySelectorAll("[data-communication-agent]").length).toBeLessThan(10);
  });
  it("formats Markdown and switches between compact, preview and full messages without losing task selection", async () => {
    let shortPhone = false;
    using _viewport = stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: shortPhone,
      addEventListener() {},
      removeEventListener() {},
    }));
    const formatted = {
      ...model,
      messages: [
        {
          ...model.messages[0]!,
          text:
            "## Findings\n\n**Confirmed** with `cache.ts`.\n\n| File | Result |\n| --- | --- |\n| cache.ts | Pass |\n\n" +
            "Additional evidence.\n".repeat(120) +
            "Final evidence marker",
        },
      ],
    };
    // These dialog fixtures do not navigate.
    await using screen = await render(
      <AgentCommunicationView
        model={formatted}
        selection={{ kind: "participant", id: "auditor" }}
        onSelect={() => {}}
      />,
      { router: false },
    );
    const feed = screen.container.querySelector('[aria-label="Messages between agents"]')!;
    expect(feed.querySelector("h2")?.textContent).toBe("Findings");
    expect(feed.querySelector("strong")?.textContent).toBe("Confirmed");
    expect(feed.querySelector("table")).not.toBeNull();
    expect(feed.textContent).not.toContain("Final evidence marker");
    await click("Show full message");
    expect(feed.textContent).toContain("Final evidence marker");
    await click("Collapse all");
    expect(feed.querySelector(".chat-markdown")).toBeNull();
    expect(feed.querySelector("article")?.getAttribute("data-reading-mode")).toBe("compact");
    await click("Read message");
    expect(feed.textContent).toContain("Final evidence marker");
    await click("Short previews");
    expect(feed.textContent).not.toContain("Final evidence marker");
    await click("Expand all");
    expect(feed.textContent).toContain("Final evidence marker");
    expect(
      screen.container
        .querySelector('[data-communication-task="auditor"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
  });
  it("offers expansion only for clipped messages and shows compact rows without Markdown syntax", async () => {
    let shortPhone = false;
    using _viewport = stubGlobal("matchMedia", (media: string) => ({
      media,
      matches: shortPhone,
      addEventListener() {},
      removeEventListener() {},
    }));
    const mixed = {
      ...model,
      messages: [
        { ...model.messages[1]!, text: "Short **note** with `code`." },
        { ...model.messages[2]!, text: "Long evidence.\n".repeat(200) },
      ],
    };
    // These dialog fixtures do not navigate.
    await using screen = await render(
      <AgentCommunicationView model={mixed} selection={{ kind: "all" }} onSelect={() => {}} />,
      { router: false },
    );
    const feed = screen.container.querySelector('[aria-label="Messages between agents"]')!;
    const [long, short] = feed.querySelectorAll("article");
    expect(long?.querySelector("button")?.textContent).toBe("Show full message");
    expect(short?.querySelector("button")).toBeNull();
    await click("Collapse all");
    expect(feed.querySelectorAll("article")[1]?.textContent).toContain("Short note with code.");
  });
});
