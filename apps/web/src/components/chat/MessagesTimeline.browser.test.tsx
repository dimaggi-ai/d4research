import * as DateTime from "effect/DateTime";
import { RegistryProvider } from "@effect/atom-react";
import { AudioPreview } from "../files/AudioPreview";
import { onTestFinished } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { stubGlobal } from "../../../test/render";
import {
  ApprovalRequestId,
  CheckpointRef,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  RunId,
  RunAttemptId,
  RuntimeRequestId,
  TurnItemId,
  ScheduledTaskId,
  ThreadId,
} from "@d4research/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextClipboardHtml,
  decodeComposerContextFragment,
} from "@d4research/shared/composerContextClipboard";
import type { LegendListRef } from "@legendapp/list/react";
import {
  createRef,
  Profiler,
  StrictMode,
  useState,
  type ComponentProps,
  type ReactElement,
} from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { serverEnvironment } from "../../state/server";
import { PullRequestLinkPreview } from "../pullRequest/PullRequestLinkPreview";
import { Tooltip, TooltipPopup, TooltipScrollDismissArea, TooltipTrigger } from "../ui/tooltip";
import { act, fakeTimers, render } from "../../../test/render";
import { MessagesTimeline } from "./MessagesTimeline";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import {
  type PendingApproval,
  deriveTimelineEntriesFromVisibleTurnItems,
} from "../../session-logic";
import { remarkThoughtPreview } from "./TimelineWorkEntryRow.logic";
import { parseMarkdownWithMath } from "@d4research/shared/markdownMath";
import { readTimelinePosition, rememberTimelinePosition } from "./timelineScrollAnchoring";

import { toastManager } from "../ui/toast";
import type { CitedHistory } from "./citationProcedure";
import type { TimelineNavigation } from "./timelineViewport";

const pullRequestQuery = vi.hoisted(() => ({ error: "Pull request not found" }));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: null,
    dataUpdatedAt: 0,
    error: pullRequestQuery.error,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));

const audioAsset = vi.hoisted(() => ({ url: "" }));
vi.mock(import("~/assets/assetUrls"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAssetUrlState: ((...args: Parameters<typeof actual.useAssetUrlState>) =>
      audioAsset.url
        ? { _tag: "Success", url: audioAsset.url }
        : actual.useAssetUrlState(...args)) as typeof actual.useAssetUrlState,
  };
});

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

// The timeline remembers scroll position and open disclosures per thread key,
// so every render gets a fresh thread.
function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
  };
}

function message(
  text: string,
  overrides: Partial<Extract<Entry, { kind: "message" }>["message"]> = {},
  id = "message-1",
): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
      ...overrides,
    },
  };
}

function work(id: string, entry: Record<string, unknown>): Entry {
  return {
    id,
    kind: "work",
    createdAt: CREATED_AT,
    entry: { id, createdAt: CREATED_AT, ...entry },
  } as Entry;
}

function v2Item(type: string, fields: Record<string, unknown>) {
  const id = (fields.id as string | undefined) ?? type;
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: "thread-1",
    sourceItemId: id,
    item: {
      id,
      threadId: "thread-1",
      runId: "run-1",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: DateTime.makeUnsafe(CREATED_AT),
      type,
      ...fields,
    },
  } as never;
}

function longText(tail = "deep hidden detail only after expand") {
  return Array.from({ length: 9 }, (_, index) =>
    index === 8 ? tail : `Line ${index + 1}: ${"verbose prompt content ".repeat(8).trim()}`,
  ).join("\n");
}

async function renderElement(element: ReactElement, options: { router?: false } = {}) {
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(element, { container, ...options });
  const buttons = (name: string | RegExp) =>
    [...container.querySelectorAll<HTMLElement>("button, [role=button]")].filter((button) => {
      const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
      return typeof name === "string" ? label === name : name.test(label);
    });
  return Object.assign(screen, {
    text: () => container.textContent ?? "",
    buttons,
    button: (name: string | RegExp) => {
      const [match] = buttons(name);
      if (!match) throw new Error(`Missing button: ${String(name)}`);
      return match;
    },
  });
}

function renderTimeline(entries: ReadonlyArray<Entry>, props: Partial<TimelineProps> = {}) {
  return renderElement(
    <MessagesTimeline {...baseProps()} timelineEntries={entries as Entry[]} {...props} />,
  );
}

async function copyRange(range: Range) {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const clipboardData = new DataTransfer();
  const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData });
  const target = range.startContainer.parentElement!;
  try {
    await act(async () => target.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    return clipboardData;
  } finally {
    selection.removeAllRanges();
  }
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

describe("MessagesTimeline work rows", () => {
  it.each([
    ["Enter", "{Enter}"],
    ["Space", " "],
  ])("opens a nested diff with %s without collapsing the tool row", async (_name, key) => {
    const onOpenToolDiff = vi.fn();
    await using screen = await renderTimeline(
      [
        work("file-change-1", {
          label: "Updated src/index.ts",
          tone: "tool",
          itemType: "file_change",
          toolLifecycleStatus: "completed",
          projectedItem: v2Item("file_change", { id: "file-change-1", fileName: "src/index.ts" }),
        }),
      ],
      { onOpenToolDiff },
    );
    const row = screen.container.querySelector<HTMLElement>('[data-v2-item-type="file_change"]')!;
    const press = async (target: HTMLElement) => {
      target.focus();
      await userEvent.keyboard(key);
    };
    expect(row.getAttribute("aria-expanded")).toBe("false");
    await press(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    const openDiff = screen.button("Open diff");
    await press(openDiff);
    expect(onOpenToolDiff).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: "file-change-1" }),
    );
    expect(onOpenToolDiff).toHaveBeenCalledTimes(1);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    await press(row);
    expect(row.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows dynamic tool input without cached output when the row is expanded", async () => {
    await using screen = await renderTimeline([
      work("tool-with-cached-output", {
        label: "Example tool",
        toolTitle: "Example tool",
        tone: "tool",
        itemType: "dynamic_tool",
        toolLifecycleStatus: "completed",
        toolData: {
          input: { query: "KEEP_TOOL_INPUT" },
          output: { text: "RAW_CACHED_TOOL_OUTPUT" },
        },
      }),
    ]);
    await click(screen.button("Example tool"));
    expect(screen.text()).toContain("KEEP_TOOL_INPUT");
    expect(screen.text()).not.toContain("RAW_CACHED_TOOL_OUTPUT");
    await click(screen.button("Example tool"));
    await vi.waitFor(() => expect(screen.text()).not.toContain("KEEP_TOOL_INPUT"));
  });

  it("expands and collapses a tool call through its header", async () => {
    await using screen = await renderTimeline([
      work("work-standalone", {
        toolCallId: "call-standalone",
        label: "Run lint",
        tone: "tool",
        itemType: "command_execution",
        command: "pnpm lint",
        toolLifecycleStatus: "completed",
      }),
    ]);
    const header = () => screen.container.querySelector<HTMLElement>("[aria-expanded]")!;
    expect(header().getAttribute("aria-expanded")).toBe("false");
    await click(header());
    expect(header().getAttribute("aria-expanded")).toBe("true");
    await click(header());
    expect(header().getAttribute("aria-expanded")).toBe("false");
  });

  it("leads an unanswered question row with the question text", async () => {
    await using screen = await renderTimeline([
      work("question-work", {
        label: "User input requested",
        tone: "tool",
        questionAnswer: {
          requestId: ApprovalRequestId.make("question-request"),
          answers: {},
          questionTextById: { scope: "Which repository?" },
          attachmentsByQuestionId: {},
        },
      }),
    ]);
    const toggle = screen.button("Which repository?");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const before = screen.text().match(/Which repository\?/g)?.length ?? 0;
    expect(before).toBeGreaterThan(0);
    await click(toggle);
    expect(screen.text().match(/Which repository\?/g)?.length).toBe(before + 1);
  });

  it("collapses settled tool runs behind a generated summary and names a failure", async () => {
    await using screen = await renderTimeline([
      work("work-1", {
        label: "Ran command",
        command: "vp lint",
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "completed",
      }),
      work("work-2", {
        label: "Run lint",
        command: "vp test run",
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "failed",
      }),
    ]);
    const summary = screen.button(/^Ran 2 commands/);
    expect(summary.getAttribute("aria-label")).toContain("tool call failed");
    expect(screen.text()).not.toContain("vp lint");
    await click(summary);
    await vi.waitFor(() => expect(screen.text()).toContain("vp lint"));
  });

  it("keeps mixed work logs neutral after a later tool call succeeds", async () => {
    await using screen = await renderTimeline([
      work("work-failed", {
        label: "Run search",
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "failed",
      }),
      work("work-info", { label: "Status updated", tone: "info" }),
      work("work-completed", {
        label: "Run tests",
        tone: "tool",
        itemType: "command_execution",
        toolLifecycleStatus: "completed",
      }),
    ]);
    // The fork shows the latest entry and counts the earlier ones.
    expect(screen.button("+2 previous log entries")).toBeDefined();
    expect(
      screen.container.querySelector('[aria-label="Hidden work includes a failure"]'),
    ).toBeNull();
  });

  it("marks a failed tool inside an expanded work log", async () => {
    await using screen = await renderTimeline([
      work("work-info", { label: "Status updated", tone: "info" }),
      work("work-1", {
        label: "Glob",
        tone: "tool",
        toolLifecycleStatus: "failed",
        detail: "No files found",
      }),
    ]);
    await click(screen.button(/^Received 1 update/));
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[aria-label="Tool call failed"]')).not.toBeNull(),
    );
  });

  it("renders context compaction entries in the normal work log", async () => {
    await using screen = await renderTimeline([
      work("work-1", { label: "Context compacted", tone: "info" }),
    ]);
    expect(screen.text()).toContain("Context compacted");
  });

  it("formats changed file paths from the workspace root", async () => {
    await using screen = await renderTimeline(
      [
        work("context-info", { label: "Session started", tone: "info" }),
        work("work-1", {
          label: "Updated files",
          tone: "tool",
          itemType: "file_change",
          toolLifecycleStatus: "completed",
          changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
        }),
      ],
      { workspaceRoot: "C:/Users/mike/dev-stuff/t3code" },
    );
    await vi.waitFor(() => expect(screen.text()).toContain("t3code/apps/web/src/session-logic.ts"));
    expect(screen.text()).not.toContain(
      "C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts",
    );
  });

  it("renders T3 MCP dynamic tools with their pretty name", async () => {
    const item = {
      id: "tool-t3-thread-read",
      type: "dynamic_tool",
      toolName: "mcp__t3-code__t3_thread_read",
      input: { threadId: "thread-child" },
      output: { messages: [] },
    };
    await using screen = await renderTimeline([
      work("context-info", { label: "Session started", tone: "info" }),
      work(item.id, {
        runId: null,
        label: item.toolName,
        tone: "tool",
        itemType: item.type,
        toolTitle: item.toolName,
        toolLifecycleStatus: "completed",
        toolData: { input: item.input, output: item.output },
        structuredPayload: v2Item("dynamic_tool", item),
        projectedItem: v2Item("dynamic_tool", item),
      }),
    ]);
    await vi.waitFor(() => expect(screen.text()).toContain("Read a T3 thread"));
    expect(screen.text()).not.toContain("mcp__t3-code__t3_thread_read");
  });

  it("keeps a provider retry collapsed in the work log", async () => {
    const retryItem = {
      id: "provider-error",
      status: "running",
      title: "Provider retry",
      failure: {
        class: "transport_error",
        message: "The response stream disconnected.",
        code: "responseStreamDisconnected",
        retryable: true,
      },
      retry: { attempt: 2, maxAttempts: 5, retryDelayMs: null },
    };
    await using screen = await renderTimeline(
      [
        work("provider-error", {
          runId: "run-1",
          label: "Retrying provider (2/5)",
          detail: retryItem.failure.message,
          tone: "info",
          itemType: "error",
          toolLifecycleStatus: "inProgress",
          projectedItem: v2Item("error", retryItem),
        }),
      ],
      {
        isWorking: true,
        latestRun: {
          runId: RunId.make("run-1"),
          status: "running",
          startedAt: CREATED_AT,
          completedAt: null,
        },
      },
    );
    expect(screen.text()).toContain("Retrying provider (2/5)");
    expect(screen.text()).not.toContain("Structured details");
  });

  it.each([
    [
      "**Viewing image first** with *care*, ~~old~~ `code` and [context](https://example.com)",
      "Viewing image first with care, old code and context",
      1,
    ],
    ["first paragraph\n\nsecond paragraph", "first paragraph second paragraph", 0],
    ["- first\n- second", "first second", 0],
    ["first  \nsecond", "first second", 0],
    ["![image description](image.png)", "image description", 0],
    ["![](image.png)", "Thought", 0],
    ["---", "Thought", 0],
  ] as const)(
    "shows plain text for a V2 reasoning preview: %s",
    async (markdown, expected, strongCount) => {
      await using screen = await renderTimeline([
        work("reasoning-preview", {
          label: markdown,
          detail: markdown,
          tone: "thinking",
          itemType: "reasoning",
          toolLifecycleStatus: "completed",
        }),
      ]);
      const row = () =>
        screen.container.querySelector<HTMLElement>("[role=button][aria-expanded]")!;
      const preview = () => row().textContent!.replace(/\s+/g, " ");
      expect(preview()).toContain(expected);
      expect(screen.container.querySelectorAll("strong")).toHaveLength(0);
      await click(row());
      expect(screen.container.querySelectorAll("strong")).toHaveLength(strongCount);
      await click(row());
      expect(preview()).toContain(expected);
      await vi.waitFor(() => expect(screen.container.querySelectorAll("strong")).toHaveLength(0));
    },
  );
});

describe("MessagesTimeline messages", () => {
  it.each([
    { role: "assistant", selection: "across", findExpanded: false },
    { role: "assistant", selection: "across", findExpanded: true },
    { role: "user", selection: "across", findExpanded: false },
    { role: "assistant", selection: "inside", findExpanded: false },
    { role: "user", selection: "source", findExpanded: false },
  ] as const)(
    "copies Mermaid selection $selection in $role messages (find expanded: $findExpanded)",
    async ({ role, selection, findExpanded }) => {
      const code = "flowchart LR\n    A[Select message] --> B[Copy Markdown]";
      const source = `\`\`\`mermaid\n${code}\n\`\`\``;
      await using screen = await renderTimeline(
        [message(`Before diagram.\n\n${source}\n\nAfter diagram.`, { role })],
        {
          findExpanded,
        },
      );
      const diagram = await vi.waitFor(
        () => {
          const svg = screen.container.querySelector('[aria-label="Expand diagram"] svg');
          expect(svg).not.toBeNull();
          return svg!;
        },
        { timeout: 10_000 },
      );
      const range = document.createRange();
      let expected = source;
      if (selection === "across") {
        const paragraphs = [...screen.container.querySelectorAll("p")];
        const before = paragraphs.find((p) => p.textContent === "Before diagram.")!.firstChild!;
        const after = paragraphs.find((p) => p.textContent === "After diagram.")!.firstChild!;
        range.setStart(before, 2);
        range.setEnd(after, 5);
        expected = `fore diagram.\n\n${source}\n\nAfter`;
      } else if (selection === "inside") {
        const label = [...diagram.querySelectorAll("p, text")].find(
          (element) => element.textContent === "Select message",
        )!;
        const labelText = document.createTreeWalker(label, NodeFilter.SHOW_TEXT).nextNode()!;
        range.setStart(labelText, 2);
        range.setEnd(labelText, 5);
      } else {
        await click(screen.button("Show code"));
        const code = screen.container.querySelector("pre code")!;
        const firstToken = document.createTreeWalker(code, NodeFilter.SHOW_TEXT).nextNode()!;
        range.setStart(firstToken, 0);
        range.setEnd(firstToken, 9);
        expected = "flowchart";
      }

      const clipboard = await copyRange(range);
      expect.soft(clipboard.getData("text/plain")).toBe(expected);
      if (selection !== "source") {
        const html = new DOMParser().parseFromString(clipboard.getData("text/html"), "text/html");
        html.querySelectorAll("[hidden]").forEach((element) => element.remove());
        expect(html.body.textContent).toContain(code);
      }
    },
  );

  it("exports context records only after selecting the chip, not its link in Mermaid source", async () => {
    const record = {
      version: 1 as const,
      kind: "image" as const,
      contextId: ComposerContextId.make("image-1"),
      label: "shot.png",
      attachmentId: "attachment-1",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 1,
    };
    const link = `[shot.png](t3-context://v1/image/${record.contextId})`;
    const code = `flowchart LR\n    A --> B\n%% ${link}`;
    const source = `\`\`\`mermaid\n${code}\n\`\`\``;
    await using screen = await renderTimeline([
      message(`Before\n\n${source}\n\nAfter\n\n${link}`, {
        context: { version: 1, records: [record] },
        attachments: [
          {
            type: "image",
            id: record.attachmentId,
            name: record.name,
            mimeType: record.mimeType,
            sizeBytes: record.sizeBytes,
          },
        ],
      }),
    ]);
    await vi.waitFor(
      () =>
        expect(screen.container.querySelector('[aria-label="Expand diagram"] svg')).not.toBeNull(),
      { timeout: 10_000 },
    );
    const paragraphs = [...screen.container.querySelectorAll("p")];
    const before = paragraphs.find((p) => p.textContent === "Before")!.firstChild!;
    const after = paragraphs.find((p) => p.textContent === "After")!.firstChild!;
    const chip = screen.button(/^Image attachment, shot\.png,/);
    const range = document.createRange();
    range.setStart(before, 0);
    range.setEnd(after, 5);

    const withoutChip = await copyRange(range);
    expect(withoutChip.getData("text/plain")).toBe(`Before\n\n${source}\n\nAfter`);
    expect(withoutChip.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME)).toBe("");
    expect(decodeComposerContextClipboardHtml(withoutChip.getData("text/html"))).toBeNull();

    range.setEndAfter(chip);
    const withChip = await copyRange(range);
    expect(withChip.getData("text/plain")).toBe(`Before\n\n${source}\n\nAfter\n\n!${link}`);
    expect(
      decodeComposerContextFragment(withChip.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME))?.records,
    ).toEqual([record]);
    expect(decodeComposerContextClipboardHtml(withChip.getData("text/html"))?.records).toEqual([
      record,
    ]);
    const html = new DOMParser().parseFromString(withChip.getData("text/html"), "text/html");
    expect(html.body.textContent).toContain(code);
  });

  it("keeps the first and last message headings reachable from either end", async () => {
    const onIsAtEndChange = vi.fn();
    const props = { ...baseProps(), onIsAtEndChange };
    // Folded messages at both ends: their headings must not live inside the fold.
    const entries = Array.from({ length: 120 }, (_, index) =>
      index === 0
        ? message("First turn", { scheduledTaskId: ScheduledTaskId.make("task-a11y") }, "turn-0")
        : index === 119
          ? message(
              "Last turn",
              { createdBy: "agent", senderThreadId: ThreadId.make("thread-sender") },
              "turn-119",
            )
          : message(
              `Turn ${index}:\n\n${"x ".repeat(200)}`,
              { role: index % 2 === 0 ? "user" : "assistant" },
              `turn-${index}`,
            ),
    );
    await using screen = await renderElement(
      <MessagesTimeline {...props} timelineEntries={entries} />,
    );
    const headings = () => [...screen.container.querySelectorAll("h3")];
    const headingFor = (text: string) =>
      headings().find((heading) => heading.parentElement?.textContent?.includes(text));
    const viewport = props.listRef.current!.getScrollableNode()!;
    // A screen reader scrolls the heading it moves to into view.
    const expectHeadingInView = async (text: string, neighbour: string) => {
      await act(() => headingFor(text)!.scrollIntoView({ block: "start" }));
      await vi.waitFor(() => expect(screen.text()).toContain(neighbour));
      const row = headingFor(text)!.parentElement!.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      expect(row.top).toBeLessThan(view.bottom);
      expect(row.bottom).toBeGreaterThan(view.top);
    };

    await vi.waitFor(() => expect(screen.text()).toContain("Turn 118:"));
    expect(screen.text()).not.toContain("Turn 60:");
    // Wrapping follows DOM order, so the ends must also sit first and last.
    await vi.waitFor(() => {
      expect(headings()[0]).toBe(headingFor("First turn"));
      expect(headings().at(-1)).toBe(headingFor("Last turn"));
    });

    await vi.waitFor(() => expect(onIsAtEndChange).toHaveBeenCalledWith(true));
    await expectHeadingInView("First turn", "Turn 1:");
    expect(headingFor("Last turn")).toBeDefined();
    await expectHeadingInView("Last turn", "Turn 118:");
  });

  it("keeps rows in item order after a reload or thread switch, before any timer runs", async () => {
    // NVDA's browse mode keeps the first DOM order it reads, so a timer that sorts rows later is too late.
    using _timers = fakeTimers();
    const thread = (name: string) =>
      Array.from({ length: 120 }, (_, index) =>
        message(
          `${name} turn ${index}:\n\n${"x ".repeat(200)}`,
          { role: index % 2 === 0 ? "user" : "assistant" },
          `${name}-${index}`,
        ),
      );
    const props = baseProps();
    await using screen = await renderElement(
      <MessagesTimeline {...props} timelineEntries={thread("A")} />,
    );
    const turnsInDomOrder = () =>
      [...screen.container.querySelectorAll("h3")].map((heading) =>
        Number(/turn (\d+):/.exec(heading.parentElement?.textContent ?? "")?.[1]),
      );
    const expectItemOrder = () => {
      const turns = turnsInDomOrder();
      expect(turns).toEqual(turns.toSorted((a, b) => a - b));
    };

    expect(screen.text()).toContain("A turn 118:");
    expect(turnsInDomOrder()).toContain(0);
    expectItemOrder();

    await screen.rerender(
      <MessagesTimeline
        {...props}
        routeThreadKey={`${props.routeThreadKey}-other`}
        timelineEntries={thread("B")}
      />,
    );
    expect(screen.text()).toContain("B turn 118:");
    expect(screen.text()).not.toContain("A turn");
    expectItemOrder();
  });

  it("puts rows back in item order soon after a continuous scroll stops", async () => {
    const props = baseProps();
    await using screen = await renderElement(
      <MessagesTimeline
        {...props}
        timelineEntries={Array.from({ length: 120 }, (_, index) =>
          message(
            `Turn ${index}:\n\n${"x ".repeat(200)}`,
            { role: index % 2 === 0 ? "user" : "assistant" },
            `turn-${index}`,
          ),
        )}
      />,
    );
    await vi.waitFor(() => expect(screen.text()).toContain("Turn 118:"));
    using _timers = fakeTimers();
    const turnsInDomOrder = () =>
      [...screen.container.querySelectorAll("h3")].map((heading) =>
        Number(/Turn (\d+):/.exec(heading.parentElement?.textContent ?? "")?.[1]),
      );
    const viewport = props.listRef.current!.getScrollableNode()!;

    const scroll = async (by: number) => {
      for (let step = 0; step < 40; step++) {
        await act(() => {
          viewport.scrollTop += by;
          viewport.dispatchEvent(new Event("scroll"));
          vi.advanceTimersByTime(16);
        });
      }
      // Wrapping right after a scroll must still reach the first and last message.
      expect(turnsInDomOrder()[0]).toBe(0);
      expect(turnsInDomOrder().at(-1)).toBe(119);
    };

    await act(() => {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(300);
    });
    await scroll(300);
    expect(turnsInDomOrder().filter((turn) => turn > 0 && turn < 100).length).toBeGreaterThan(0);
    await scroll(-300);

    await act(() => vi.advanceTimersByTime(300));
    const turns = turnsInDomOrder();
    expect(turns).toEqual(turns.toSorted((a, b) => a - b));
  });

  it("preserves XML-like tags and comparisons in user messages as text", async () => {
    const source = [
      'Without reading a file, do you have <global-agent-instructions scope="workspace">',
      'Before <nested data-value="a&b">inside</nested> after',
      "</global-agent-instructions> in your context?",
      "Comparison: 2 < 3 and 5 > 4.",
    ];
    await using screen = await renderTimeline([message(source.join("\n"))]);
    for (const line of source) expect(screen.text()).toContain(line);
    expect(screen.container.querySelector("global-agent-instructions, nested")).toBeNull();
  });

  it("preserves XML-like source inside user code spans and fences", async () => {
    await using screen = await renderTimeline([
      message(
        [
          'Inline `<tag attr="x">`',
          "",
          "```xml",
          '<root><child enabled="true" /></root>',
          "```",
        ].join("\n"),
      ),
    ]);
    expect(screen.container.querySelector("code[data-inline-code]")?.textContent).toBe(
      '<tag attr="x">',
    );
    expect(screen.text()).toContain('<root><child enabled="true" /></root>');
  });

  it("does not show markdown titles in user messages", async () => {
    await using screen = await renderTimeline([
      message(
        '[link](https://example.com "link tip") ![image](https://example.com/image.png "image tip")',
      ),
    ]);
    expect(screen.container.querySelector('a[href="https://example.com"]')).not.toBeNull();
    expect(
      screen.container.querySelector('img[src="https://example.com/image.png"]'),
    ).not.toBeNull();
    expect(screen.container.querySelector('[title="link tip"], [title="image tip"]')).toBeNull();
  });

  it("renders unsafe user HTML as inert source text", async () => {
    const source =
      '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">';
    await using screen = await renderTimeline([message(source)]);
    expect(screen.text()).toContain(source);
    expect(screen.container.querySelector("script, img")).toBeNull();
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });

  it("renders sanitized raw HTML in assistant messages", async () => {
    await using screen = await renderTimeline([
      message(
        [
          '<details onclick="globalThis.__t3Xss = 1">',
          "<summary>Safe details</summary>",
          "<script>globalThis.__t3Xss = 2</script>",
          '<img src="x" onerror="globalThis.__t3Xss = 3">',
          '<a href="javascript:globalThis.__t3Xss = 4">Unsafe link</a>',
          "</details>",
        ].join(""),
        { role: "assistant" },
      ),
    ]);
    expect(screen.container.querySelector("[data-markdown-details]")?.textContent).toContain(
      "Safe details",
    );
    expect(screen.text()).not.toContain("<details");
    expect(screen.container.querySelector("script, [onclick], [onerror]")).toBeNull();
    expect(screen.container.innerHTML).not.toContain("javascript:");
    await click(screen.button("Safe details"));
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });

  it("collapses long user messages behind a toggle and keeps their copy button", async () => {
    await using screen = await renderTimeline([message(longText())]);
    const toggle = screen.button("Show full message");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.buttons("Copy message")).toHaveLength(1);
    await click(toggle);
    expect(screen.button("Show less").getAttribute("aria-expanded")).toBe("true");
  });

  it("does not offer a collapse toggle for short user messages", async () => {
    await using screen = await renderTimeline([message("Short prompt.")]);
    expect(screen.buttons(/Show full message|Show less/)).toHaveLength(0);
  });

  it("identifies user-role messages sent by another agent", async () => {
    {
      await using screen = await renderTimeline([
        message("Review this area", { createdBy: "agent", creationSource: "provider" }),
      ]);
      const header = screen.button(/^Agent.*Review this area$/);
      expect(header.getAttribute("aria-expanded")).toBe("false");
      await click(header);
      expect(header.getAttribute("aria-expanded")).toBe("true");
    }
    await using screen = await renderTimeline([message("Review this area")]);
    expect(screen.buttons(/^Agent/)).toHaveLength(0);
  });

  it("shows steer intent ahead of committed user messages", async () => {
    await using screen = await renderTimeline([
      message("Adjust the current turn", { inputIntent: "steer" }),
    ]);
    expect(screen.text().indexOf("Steer")).toBeGreaterThanOrEqual(0);
    expect(screen.text().indexOf("Steer")).toBeLessThan(
      screen.text().indexOf("Adjust the current turn"),
    );
  });

  it("renders inline terminal labels as chips", async () => {
    await using screen = await renderTimeline([
      message(
        [
          longText("yoo what's @terminal-1:1-5 mean"),
          "",
          "<terminal_context>",
          "- Terminal 1 lines 1-5:",
          "  1 | julius@mac effect-http-ws-cli % bun i",
          "  2 | bun install v1.3.9 (cf6cdbbb)",
          "</terminal_context>",
        ].join("\n"),
      ),
    ]);
    expect(screen.text()).toContain("Terminal 1 lines 1-5");
    expect(screen.text()).toContain("yoo what's");
    expect(screen.text()).not.toContain("terminal_context");
    expect(screen.buttons("Show full message")).toHaveLength(1);
  });

  it("renders chips for standalone element-pick context messages", async () => {
    await using screen = await renderTimeline([
      message(
        [
          "<element_context>",
          "- <SubmitButton> (Button.tsx:12):",
          "  url: https://example.com/dashboard",
          "  selector: button.submit",
          "  source: /repo/src/Button.tsx:12:5",
          "  html:",
          '  <button class="submit">Save</button>',
          "</element_context>",
        ].join("\n"),
      ),
    ]);
    expect(screen.text()).toContain("SubmitButton");
    expect(screen.text()).not.toContain("element_context");
  });

  it("renders review comment contexts as structured cards instead of raw tags", async () => {
    await using screen = await renderTimeline([
      message(
        [
          '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="apps/web/src/lib/contextWindow.test.ts" startIndex="3" endIndex="14" rangeLabel="+47 to +58">',
          "Wadduo",
          "```diff",
          "@@ -0,0 +47,2 @@",
          '+  it("keeps valid zero-usage snapshots", () => {',
          "+    expect(snapshot).not.toBeNull();",
          "```",
          "</review_comment>",
        ].join("\n"),
      ),
    ]);
    expect(screen.text()).toContain("contextWindow.test.ts L47 to L58");
    expect(screen.text()).not.toContain("review_comment");
  });

  it("renders file review comments as source code", async () => {
    await using screen = await renderTimeline([
      message(
        [
          '<review_comment sectionId="file:docs/plan.md" sectionTitle="File comment" filePath="docs/plan.md" startIndex="0" endIndex="1" rangeLabel="L1 to L2">',
          "Clarify this.",
          "```md",
          "# Plan",
          "- Step one",
          "```",
          "</review_comment>",
        ].join("\n"),
      ),
    ]);
    expect(screen.text()).toContain("plan.md L1 to L2");
    expect(screen.text()).not.toContain("review_comment");
  });

  it("collapses superseded attempt output behind a disclosure", async () => {
    const runId = RunId.make("run-steered");
    const attempt = (id: string, ordinal: number, status: string) =>
      ({
        id,
        runId,
        attemptOrdinal: ordinal,
        rootNodeId: `node-${id}`,
        status,
        completedAt: null,
      }) as never;
    await using screen = await renderTimeline(
      [
        {
          ...message(
            "Partial response from the old attempt",
            { role: "assistant", runId },
            "superseded-response",
          ),
          attempt: attempt("attempt-1", 1, "superseded"),
        } as Entry,
        {
          ...message(
            "Current response remains visible",
            { role: "assistant", runId, streaming: true },
            "active-response",
          ),
          attempt: attempt("attempt-2", 2, "running"),
        } as Entry,
      ],
      {
        latestRun: { runId, status: "running", startedAt: CREATED_AT, completedAt: null },
      },
    );
    expect(screen.text()).toContain("Current response remains visible");
    expect(screen.text()).not.toContain("Partial response from the old attempt");
    const disclosure = screen.button(/Superseded attempt/);
    expect(disclosure.textContent).toContain("Cut off by a steer");
    await click(disclosure);
    expect(screen.text()).toContain("Partial response from the old attempt");
  });

  it("forks from a completed assistant response", async () => {
    const onForkFromRun = vi.fn(async () => {});
    await using screen = await renderTimeline(
      [
        {
          ...message("Done", { role: "assistant", runId: RunId.make("run-1") }, "assistant-1"),
          projectedItem: v2Item("assistant_message", {
            id: "assistant-item-1",
            messageId: "assistant-1",
            text: "Done",
            streaming: false,
          }),
        } as Entry,
      ],
      { onForkFromRun },
    );
    await click(screen.button("Fork from this response"));
    expect(onForkFromRun).toHaveBeenCalledWith({ sourceThreadId: "thread-1", runId: "run-1" });
  });

  it("opens the changed files of an assistant response", async () => {
    const assistantMessageId = MessageId.make("assistant-with-files");
    const runId = RunId.make("run-with-files");
    const onOpenTurnDiff = vi.fn();
    await using screen = await renderTimeline(
      [message("Updated the fixture.", { role: "assistant", runId }, assistantMessageId)],
      {
        onOpenTurnDiff,
        latestRun: { runId, status: "completed", startedAt: CREATED_AT, completedAt: CREATED_AT },
        turnDiffSummaries: [
          {
            runId,
            checkpointTurnCount: 1,
            checkpointRef: CheckpointRef.make("checkpoint-with-files"),
            status: "ready",
            files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
            assistantMessageId,
            completedAt: CREATED_AT,
          },
        ],
      },
    );
    expect(screen.text()).toContain("1 changed file");
    await click(screen.button("Open diff"));
    expect(onOpenTurnDiff).toHaveBeenCalledWith(runId, "README.md");
  });
});

describe("MessagesTimeline attachments", () => {
  const withAttachment = (attachment: Record<string, unknown>) =>
    message("Read the report.", {
      attachments: [
        {
          type: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
          ...attachment,
        },
      ] as never,
    });

  it("offers preview and download actions for PDF attachments", async () => {
    await using screen = await renderTimeline([
      withAttachment({
        id: "attachment-report-pdf",
        previewUrl: "https://environment.test/api/assets/report.pdf",
      }),
    ]);
    expect(screen.buttons("Preview report.pdf")).toHaveLength(1);
    expect(screen.buttons("Download report.pdf")).toHaveLength(1);
    expect(screen.container.querySelector('img[alt="report.pdf"]')).toBeNull();
  });

  it("does not create a download URL before the download is requested", async () => {
    await using screen = await renderTimeline([withAttachment({ id: "attachment-report-pdf" })]);
    expect(screen.buttons("Download report.pdf")).toHaveLength(1);
    expect(screen.container.querySelector("a[href]")).toBeNull();
  });

  it("does not download an optimistic file before the server supplies its attachment ID", async () => {
    await using screen = await renderTimeline([
      withAttachment({ id: "composer-local-report", downloadable: false }),
    ]);
    expect(screen.text()).toContain("report.pdf");
    expect(screen.buttons("Download report.pdf")).toHaveLength(0);
  });

  it("renders unknown attachment types as inert rows instead of crashing", async () => {
    await using screen = await renderTimeline([
      withAttachment({
        type: "recording",
        id: "attachment-voice-memo",
        name: "voice-memo.ogg",
        mimeType: "audio/ogg",
      }),
    ]);
    expect(screen.text()).toContain("voice-memo.ogg");
    expect(screen.buttons("Download voice-memo.ogg")).toHaveLength(0);
    expect(screen.container.querySelector("a[href], img")).toBeNull();
  });

  it("shows SnapShot window details only after the preview resolves", async () => {
    const snapShot = (previewUrl?: string) =>
      message("First prompt.", {
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 1,
            ...(previewUrl ? { previewUrl } : {}),
            source: {
              kind: "snap-shot",
              capturedAt: CREATED_AT,
              appName: "Terminal",
              windowTitle: "t3code — Tests",
              appIconDataUrl: "data:image/png;base64,aWNvbg==",
            },
          },
        ] as never,
      });
    {
      await using screen = await renderTimeline([snapShot()]);
      expect(screen.text()).toContain("screenshot.png");
      expect(screen.text()).not.toContain("t3code — Tests");
    }
    await using screen = await renderTimeline([snapShot("data:image/png;base64,iVBORw0KGgo=")]);
    expect(screen.text()).toContain("Terminal");
    expect(screen.text()).toContain("t3code — Tests");
  });
});

describe("MessagesTimeline history and thread links", () => {
  it.each([
    ["imported runless", null],
    ["standard", RunId.make("citation-run")],
  ] as const)("reveals a cited response inside a folded %s turn", async (_label, runId) => {
    const quote = "The imported response contains this cited detail.";
    const props = {
      ...baseProps(),
      timelineEntries: [
        message("Investigate the issue.", { runId }, "citation-prompt"),
        message("I will investigate the issue.", { role: "assistant", runId }, "citation-intro"),
        message(quote, { role: "assistant", runId }, "citation-source"),
        message("Investigation complete.", { role: "assistant", runId }, "citation-answer"),
      ],
    };
    await using screen = await renderElement(<MessagesTimeline {...props} />);
    const source = () =>
      screen.container.querySelector<HTMLElement>(
        '[data-assistant-citation-source="citation-source"]',
      );
    await vi.waitFor(() => expect(screen.text()).toContain("Investigation complete."));
    expect(screen.buttons(/^Worked/)).toHaveLength(1);
    expect(source()).toBeNull();

    await screen.rerender(
      <MessagesTimeline
        {...props}
        citationRequest={{
          key: "open-citation",
          citation: {
            version: 1,
            environmentId: ENVIRONMENT_ID,
            threadId: ThreadId.make(props.routeThreadKey.slice("environment-local:".length)),
            messageId: MessageId.make("citation-source"),
            text: quote,
            start: 0,
            end: quote.length,
            prefix: "",
            suffix: "",
          },
        }}
      />,
    );

    await vi.waitFor(() => {
      expect(source()?.textContent ?? "").toContain(quote);
      const highlight = CSS.highlights.get("t3-assistant-citation");
      expect(highlight).toBeDefined();
      const range = [...highlight!][0] as Range;
      expect(range.toString()).toBe(quote);
      const viewport = screen.container.querySelector<HTMLElement>(
        "[data-assistant-citation-viewport]",
      )!;
      const bounds = range.getBoundingClientRect();
      expect(bounds.height).toBeGreaterThan(0);
      expect(bounds.top).toBeGreaterThanOrEqual(viewport.getBoundingClientRect().top);
      expect(bounds.bottom).toBeLessThanOrEqual(viewport.getBoundingClientRect().bottom);
    });
  });

  it("loads earlier turns from a control ahead of the bounded timeline", async () => {
    const onLoadEarlier = vi.fn();
    await using screen = await renderTimeline([message("Recent activity")], {
      historyControls: {
        hasMoreHistory: true,
        loading: false,
        error: "Earlier activity could not be loaded.",
        onLoadEarlier,
      },
    });
    expect(screen.text()).toContain("Earlier activity could not be loaded.");
    expect(screen.text().indexOf("Load earlier turns")).toBeLessThan(
      screen.text().indexOf("Recent activity"),
    );
    await click(screen.button("Load earlier turns"));
    expect(onLoadEarlier).toHaveBeenCalledOnce();
  });

  it("keeps an empty bounded timeline busy while earlier history loads", async () => {
    await using screen = await renderTimeline([], {
      historyControls: {
        hasMoreHistory: true,
        loading: true,
        error: null,
        onLoadEarlier: () => {},
      },
    });
    expect(screen.text()).toContain("Loading earlier turns…");
    expect(screen.button("Load earlier turns")).toHaveProperty("disabled", true);
    expect(screen.text()).not.toContain("Send a message to start the conversation.");
  });

  it("opens the parent thread from the top of an empty subagent timeline", async () => {
    const onOpenThread = vi.fn();
    await using screen = await renderTimeline([], {
      onOpenThread,
      parentThreadLink: { open: () => onOpenThread("thread-parent"), title: "Architecture audit" },
    });
    expect(screen.text()).toContain("Subagent of");
    expect(screen.text()).toContain("Architecture audit");
    expect(screen.text()).not.toContain("Send a message to start the conversation");
    await click(screen.button("Open parent thread"));
    expect(onOpenThread).toHaveBeenCalledWith("thread-parent");
  });

  it("opens a thread at its newest message after an empty pane and restores it on return", async () => {
    const props = baseProps();
    const entries = Array.from({ length: 12 }, (_, index) =>
      message(
        Array.from({ length: 60 }, (_, line) => `Paragraph ${index}.${line}`).join("\n\n"),
        { role: "assistant" },
        `message-${index}`,
      ),
    );
    await using screen = await renderTimeline([], {
      ...props,
      routeThreadKey: `${props.routeThreadKey}-loading`,
      hideEmptyPlaceholder: true,
    });

    // Each row is much taller than LegendList's estimate.
    await screen.rerender(<MessagesTimeline {...props} timelineEntries={entries} />);
    const viewport = props.listRef.current!.getScrollableNode();
    await vi.waitFor(() => {
      expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
      expect(screen.text()).toContain("Paragraph 11.59");
      expect(
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      ).toBeLessThanOrEqual(1);
    });

    const otherThreadKey = `${props.routeThreadKey}-other`;
    await screen.rerender(
      <MessagesTimeline
        {...props}
        routeThreadKey={otherThreadKey}
        timelineEntries={entries}
        liveFollowEnabled={false}
      />,
    );
    await vi.waitFor(() =>
      expect(
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      ).toBeLessThanOrEqual(1),
    );
    // Move beyond LegendList's one-viewport follow threshold so it cannot mask restoration.
    await act(() => {
      viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -2000, bubbles: true }));
      viewport.scrollTop -= 2000;
      viewport.dispatchEvent(new Event("scroll"));
    });
    await vi.waitFor(() => {
      expect(readTimelinePosition(otherThreadKey)?.atEnd).toBe(false);
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeGreaterThan(
        viewport.clientHeight,
      );
    });

    await screen.rerender(<MessagesTimeline {...props} timelineEntries={entries} />);
    await vi.waitFor(() => {
      expect(screen.text()).toContain("Paragraph 11.59");
      expect(
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      ).toBeLessThanOrEqual(1);
    });
  });

  it("does not render the transient V2 interruption request", async () => {
    await using screen = await renderTimeline([
      {
        id: "interrupt-request",
        kind: "event",
        createdAt: CREATED_AT,
        projectedItem: v2Item("run_interrupt_request", {
          id: "interrupt-request",
          message: "Waiting for the provider to stop.",
        }),
      } as Entry,
    ]);
    expect(screen.text()).not.toContain("Interrupt requested");
    expect(screen.text()).not.toContain("Waiting for the provider to stop.");
  });

  it("opens created threads from a lean row", async () => {
    const onOpenThread = vi.fn();
    await using screen = await renderTimeline(
      [
        {
          id: "thread-created",
          kind: "event",
          createdAt: CREATED_AT,
          projectedItem: v2Item("thread_created", {
            id: "thread-created",
            nodeId: "node-1",
            ordinal: 1,
            title: "Claude research thread",
            targetThreadId: "thread-2",
            targetRunId: "run-2",
            targetProviderInstanceId: "claude-default",
            targetModel: "claude-sonnet-4-6",
          }),
        } as Entry,
      ],
      { onOpenThread },
    );
    expect(screen.text()).toContain("Claude research thread");
    expect(screen.text()).not.toContain("Work Log");
    await click(screen.button("Open Claude research thread"));
    expect(onOpenThread).toHaveBeenCalledWith("thread-2");
  });

  it("renders context handoffs as from → to model endpoints instead of the summary", async () => {
    const provider = (instanceId: string, driver: string, slug: string, name: string) => ({
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: {},
      checkedAt: CREATED_AT,
      models: [{ slug, name, isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
    });
    const providers = [
      provider("codex_personal", "codex", "gpt-5.6-sol", "GPT 5.6 Sol"),
      provider("claudeAgent", "claudeAgent", "claude-fable-5", "Claude Fable 5"),
    ] as never;
    const handoff = (fields: Record<string, unknown>) =>
      ({
        id: "handoff-1",
        kind: "event",
        createdAt: CREATED_AT,
        projectedItem: v2Item("handoff", {
          id: "handoff-1",
          runId: "run-2",
          title: "Provider handoff",
          contextHandoffId: "handoff-1",
          fromProviderThreadIds: ["provider-thread-1"],
          toProviderThreadId: "provider-thread-2",
          strategy: "full_thread_summary",
          summary: "Full conversation context for provider handoff.",
          fromProviderInstanceIds: ["codex_personal"],
          toProviderInstanceId: "claudeAgent",
          ...fields,
        }),
      }) as Entry;
    const show = (entry: Entry, props: Partial<TimelineProps> = {}) =>
      renderElement(
        <RegistryProvider
          initialValues={[[serverEnvironment.providersValueAtom(ENVIRONMENT_ID), providers]]}
        >
          <MessagesTimeline {...baseProps()} timelineEntries={[entry]} {...props} />
        </RegistryProvider>,
      );

    {
      await using screen = await show(
        handoff({
          fromModelSelections: [{ instanceId: "codex_personal", model: "gpt-5.6-sol" }],
          toModel: "claude-fable-5",
        }),
      );
      expect(screen.text()).toContain("Context handoff");
      expect(screen.text()).toContain("5.6 Sol");
      expect(screen.text()).toContain("Fable 5");
      expect(screen.text()).not.toContain("Full conversation context");
    }

    {
      await using screen = await show(handoff({}), {
        runs: [
          {
            id: "run-1",
            ordinal: 1,
            providerInstanceId: "codex_personal",
            modelSelection: { instanceId: "codex_personal", model: "gpt-5.6-sol" },
          },
          {
            id: "run-2",
            ordinal: 2,
            providerInstanceId: "claudeAgent",
            modelSelection: { instanceId: "claudeAgent", model: "claude-fable-5" },
          },
        ] as never,
      });
      expect(screen.text()).toContain("5.6 Sol");
      expect(screen.text()).toContain("Fable 5");
    }

    await using screen = await show(handoff({}));
    expect(screen.text()).toContain("Codex Personal");
    expect(screen.text()).not.toContain("Full conversation context");
  });
});

describe("MessagesTimeline subagents", () => {
  it.each(
    (
      [
        {
          status: "running",
          progress: "Reading src/index.ts",
          result: null,
          preview: "Reading src/index.ts",
        },
        {
          status: "completed",
          progress: "Reading src/index.ts",
          result: "Tests should be isolated.",
          preview: "Tests should be isolated.",
        },
        {
          status: "running",
          progress: "Reading src/index.ts",
          result: "Partial streamed answer",
          preview: "Reading src/index.ts",
        },
        {
          status: "running",
          progress: undefined,
          result: "Streaming answer so far",
          preview: "Streaming answer so far",
        },
        {
          status: "cancelled",
          progress: "Reading src/index.ts",
          result: "Partial output before cancel",
          preview: "Partial output before cancel",
        },
        {
          status: "completed",
          progress: "Audited 12 packages",
          result: "  \n\t  ",
          preview: "Audited 12 packages",
        },
      ] as const
    ).flatMap((scenario) => [1, 2].map((count) => ({ ...scenario, count }))),
  )(
    "shows $count $status subagents with '$preview', grouping only multiple agents",
    async ({ status, progress, result, preview, count }) => {
      const onOpenThread = vi.fn();
      await using screen = await renderTimeline(
        Array.from(
          { length: count },
          (_, index) =>
            ({
              id: `subagent-progress-${index}`,
              kind: "event",
              createdAt: CREATED_AT,
              projectedItem: v2Item("subagent", {
                id: `subagent-progress-${index}`,
                nodeId: `node-subagent-${index}`,
                providerThreadId: "provider-thread-1",
                providerTurnId: "provider-turn-1",
                ordinal: 1,
                status,
                title: "Package audit",
                subagentId: `node-subagent-${index}`,
                origin: "provider_native",
                driver: "claudeAgent",
                providerInstanceId: "claudeAgent",
                childThreadId: "thread-subagent-1",
                prompt: "Inspect the package",
                progress,
                result,
              }),
            }) as Entry,
        ),
        { onOpenThread },
      );
      const children = () => screen.buttons("Open Package audit");
      // A settled run folds its work behind a "Worked for" summary.
      const fold = screen.buttons(/^Worked for/)[0];
      if (fold) await click(fold);
      if (count > 1) {
        expect(children()).toHaveLength(0);
        await click(screen.button(`${count} subagents`));
      } else {
        expect(screen.buttons(`${count} subagents`)).toHaveLength(0);
      }
      expect(children()).toHaveLength(count);
      expect(screen.text()).toContain(preview);
      expect(screen.text()).not.toContain("Inspect the package");
      if (result?.trim() && result !== preview) expect(screen.text()).not.toContain(result);
      if (progress && progress !== preview) expect(screen.text()).not.toContain(progress);
      await click(children()[0]!);
      expect(onOpenThread).toHaveBeenCalledWith("thread-subagent-1");
      if (count > 1) {
        await click(screen.button(`${count} subagents`));
        await vi.waitFor(() => expect(children()).toHaveLength(0));
      }
    },
  );
});

describe("timeline tooltip scroll dismissal", () => {
  const openPopup = () =>
    document.querySelector('[data-slot="tooltip-popup"][data-open]')?.textContent ?? null;

  async function renderTooltip(pullRequest: boolean, outside: boolean) {
    const tooltip = pullRequest ? (
      <PullRequestLinkPreview
        link={<button>message link</button>}
        originalUrl="https://example.com"
        target={{
          environmentId: ENVIRONMENT_ID,
          input: { projectId: "project-1" as never, repository: "pingdotgg/t3code", number: 1 },
        }}
      />
    ) : (
      <Tooltip>
        <TooltipTrigger delay={50}>message link</TooltipTrigger>
        <TooltipPopup>https://example.com</TooltipPopup>
      </Tooltip>
    );
    const screen = await renderElement(
      <>
        <TooltipScrollDismissArea>
          <div data-testid="scrollable" className="h-[100px] overflow-auto">
            {outside ? null : tooltip}
            <div className="h-[1000px]" />
          </div>
        </TooltipScrollDismissArea>
        {outside ? tooltip : null}
      </>,
    );
    return Object.assign(screen, {
      trigger: screen.container.querySelector<HTMLButtonElement>("button")!,
      scrollable: screen.container.querySelector<HTMLElement>('[data-testid="scrollable"]')!,
    });
  }

  async function scroll(scrollable: HTMLElement) {
    await act(async () => {
      scrollable.scrollTop += 50;
      scrollable.dispatchEvent(new Event("scroll"));
    });
  }

  it.each([false, true])(
    "closes a hovered tooltip on scroll but keeps a focused one (pull request=%s)",
    async (pullRequest) => {
      await using screen = await renderTooltip(pullRequest, false);
      const { trigger, scrollable } = screen;
      await userEvent.hover(trigger);
      await vi.waitFor(() => expect(openPopup()).toBe("https://example.com"));
      await scroll(scrollable);
      await vi.waitFor(() => expect(openPopup()).toBeNull());

      await userEvent.unhover(trigger);
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(trigger);
      await vi.waitFor(() => expect(openPopup()).toBe("https://example.com"));
      await scroll(scrollable);
      expect(openPopup()).toBe("https://example.com");
      expect(document.activeElement).toBe(trigger);
    },
  );

  it("leaves tooltips outside the timeline open when it scrolls", async () => {
    await using screen = await renderTooltip(false, true);
    const { trigger, scrollable } = screen;
    await userEvent.hover(trigger);
    await vi.waitFor(() => expect(openPopup()).toBe("https://example.com"));
    await scroll(scrollable);
    expect(openPopup()).toBe("https://example.com");
  });

  it("keeps a hovered tooltip open on a wheel that does not scroll", async () => {
    await using screen = await renderTooltip(false, false);
    const { trigger, scrollable } = screen;
    await userEvent.hover(trigger);
    await vi.waitFor(() => expect(openPopup()).toBe("https://example.com"));
    await act(async () => {
      scrollable.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 100 }));
    });
    expect(openPopup()).toBe("https://example.com");
  });
});

describe("MessagesTimeline scroll position", () => {
  const tall = (index: number) =>
    message(
      `Message ${index}\n\n${"Long paragraph. ".repeat(80)}`,
      { role: "assistant" },
      `message-${index}`,
    );
  const tallEntries = Array.from({ length: 12 }, (_, index) => tall(index));

  async function waitForList(props: ReturnType<typeof baseProps>) {
    await vi.waitFor(() => {
      const viewport = props.listRef.current?.getScrollableNode();
      expect(viewport?.scrollHeight ?? 0).toBeGreaterThan(viewport?.clientHeight ?? 0);
    });
    return props.listRef.current!.getScrollableNode()!;
  }

  it("settles when earlier short replies load above long ones", async () => {
    const props = baseProps();
    const short = Array.from({ length: 80 }, (_, index) =>
      message(`Short reply ${index}`, { role: "assistant" }, `short-${index}`),
    );
    const long = Array.from({ length: 4 }, (_, index) =>
      message(
        `${"Long handbook paragraph. ".repeat(40)}\n\n`.repeat(60),
        { role: "assistant" },
        `long-${index}`,
      ),
    );
    let nestedCommits = 0;
    let maxNestedCommits = 0;
    const onRender = (_id: string, phase: string) => {
      nestedCommits = phase === "nested-update" ? nestedCommits + 1 : 0;
      maxNestedCommits = Math.max(maxNestedCommits, nestedCommits);
    };
    const timeline = (entries: Entry[]) => (
      <Profiler id="timeline" onRender={onRender}>
        <MessagesTimeline {...props} timelineEntries={entries} />
      </Profiler>
    );
    await using screen = await renderElement(timeline(long));
    const viewport = await waitForList(props);
    await act(async () => {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
    });

    maxNestedCommits = 0;
    await screen.rerender(timeline([...short, ...long]));
    await vi.waitFor(async () => {
      await act(async () => {
        viewport.scrollTop = 0;
        viewport.dispatchEvent(new Event("scroll"));
      });
      expect(screen.text()).toContain("Short reply 0");
    });
    expect(maxNestedCommits).toBeLessThan(8);
  });

  it("restores a manual reading position after reopening and switching threads", async () => {
    const props = baseProps();
    function Chat() {
      const [liveFollowEnabled, setLiveFollowEnabled] = useState(true);
      // The chat view stops following the live edge when the reader scrolls.
      return (
        <div className="contents" onWheelCapture={() => setLiveFollowEnabled(false)}>
          <MessagesTimeline
            {...props}
            timelineEntries={tallEntries}
            liveFollowEnabled={liveFollowEnabled}
          />
        </div>
      );
    }
    let offset: number;
    {
      await using _chat = await renderElement(<Chat />);
      const viewport = await waitForList(props);
      await vi.waitFor(() => expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(true));

      await act(() => {
        viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: -600, bubbles: true }));
        viewport.scrollTop -= 600;
        viewport.dispatchEvent(new Event("scroll"));
      });
      await vi.waitFor(() => expect(readTimelinePosition(props.routeThreadKey)?.atEnd).toBe(false));
      offset = viewport.scrollTop;
    }
    expect(readTimelinePosition(props.routeThreadKey)).toMatchObject({
      atEnd: false,
      scrollOffset: offset,
    });

    const timeline = (routeThreadKey: string) => (
      <MessagesTimeline
        {...props}
        routeThreadKey={routeThreadKey}
        timelineEntries={tallEntries}
        // ChatView restores this flag from the same remembered position when changing routes.
        liveFollowEnabled={readTimelinePosition(routeThreadKey)?.atEnd !== false}
      />
    );
    await using screen = await renderElement(timeline(props.routeThreadKey));
    const reopenedViewport = await waitForList(props);
    await vi.waitFor(() =>
      expect(Math.abs(reopenedViewport.scrollTop - offset)).toBeLessThanOrEqual(1),
    );

    await screen.rerender(timeline(`${props.routeThreadKey}-other`));
    await vi.waitFor(() =>
      expect(
        reopenedViewport.scrollHeight - reopenedViewport.clientHeight - reopenedViewport.scrollTop,
      ).toBeLessThanOrEqual(1),
    );
    await screen.rerender(timeline(props.routeThreadKey));
    await vi.waitFor(() =>
      expect(Math.abs(reopenedViewport.scrollTop - offset)).toBeLessThanOrEqual(1),
    );
  });
});

describe("MessagesTimeline send anchor", () => {
  it("reports the anchored sent message once it is laid out", async () => {
    const onAnchorReady = vi.fn();
    const sent = message("Newest prompt.", {}, "message-2");
    await using _screen = await renderTimeline(
      [message("Earlier reply.", { role: "assistant" }), sent],
      {
        anchorMessageId: MessageId.make("message-2"),
        onAnchorReady,
        contentInsetEndAdjustment: 144,
      },
    );
    await vi.waitFor(() =>
      expect(onAnchorReady).toHaveBeenCalledWith(MessageId.make("message-2"), 1),
    );
  });

  it("does not anchor a follow-up user message that is not the newest turn", async () => {
    const onAnchorReady = vi.fn();
    await using _screen = await renderTimeline(
      [message("First prompt."), message("Newest prompt.", {}, "message-2")],
      {
        anchorMessageId: MessageId.make("message-2"),
        onAnchorReady,
      },
    );
    await vi.waitFor(() => expect(_screen.text()).toContain("Newest prompt."));
    expect(onAnchorReady).not.toHaveBeenCalled();
  });
});

it("returns to the latest message when the remembered row no longer exists", async () => {
  const props = baseProps();
  rememberTimelinePosition(props.routeThreadKey, {
    rowId: "removed-row",
    offsetWithinRow: 20,
    scrollOffset: 0,
    atEnd: false,
  });
  const onIsAtEndChange = vi.fn();
  await using _screen = await renderTimeline(
    Array.from({ length: 12 }, (_, index) =>
      message(
        `Message ${index}\n\n${"Long paragraph. ".repeat(80)}`,
        { role: "assistant" },
        `m-${index}`,
      ),
    ),
    { ...props, liveFollowEnabled: false, onIsAtEndChange },
  );
  await vi.waitFor(() => {
    const viewport = props.listRef.current?.getScrollableNode();
    expect(viewport?.scrollHeight ?? 0).toBeGreaterThan(viewport?.clientHeight ?? 0);
    expect(viewport!.scrollTop + viewport!.clientHeight).toBeGreaterThanOrEqual(
      viewport!.scrollHeight - 2,
    );
  });
  await vi.waitFor(() => expect(onIsAtEndChange).toHaveBeenCalledWith(true));
});

describe("MessagesTimeline attachments", () => {
  it.each(["loadedmetadata", "loadeddata", "canplay"])(
    "plays audio with unknown duration after %s and updates the total later",
    async (readyEvent) => {
      const onOpen = vi.fn();
      const preview = (failed = false) => (
        <AudioPreview
          compact
          src="data:audio/webm;base64,"
          name="recording.webm"
          failed={failed}
          onOpen={onOpen}
        />
      );
      await using screen = await renderElement(preview());
      const audio = screen.container.querySelector("audio")!;
      const duration = vi.spyOn(audio, "duration", "get").mockReturnValue(Infinity);
      const play = vi.spyOn(audio, "play").mockResolvedValue();
      expect(screen.button("Loading recording.webm")).toHaveProperty("disabled", true);
      await act(() => audio.dispatchEvent(new Event(readyEvent)));
      expect(screen.button("Play recording.webm")).toHaveProperty("disabled", false);
      expect(screen.text()).toContain("0:00");
      expect(screen.text()).not.toContain("/");
      await click(screen.button("Play recording.webm"));
      expect(play).toHaveBeenCalledOnce();
      await act(() => {
        vi.spyOn(audio, "currentTime", "get").mockReturnValue(3);
        audio.dispatchEvent(new Event("play"));
        audio.dispatchEvent(new Event("timeupdate"));
      });
      expect(screen.button("Pause recording.webm")).toHaveProperty("disabled", false);
      expect(screen.text()).toContain("0:03");
      const progress = screen.container.querySelector<HTMLElement>("span[aria-hidden]")!;
      expect(progress.style.width).toBe("0%");
      await act(() => {
        duration.mockReturnValue(10);
        audio.dispatchEvent(new Event("durationchange"));
      });
      expect(screen.text()).toContain("0:03 / 0:10");
      expect(progress.style.width).toBe("30%");
      await act(() => {
        duration.mockReturnValue(NaN);
        audio.dispatchEvent(new Event("durationchange"));
      });
      expect(screen.text()).not.toContain("/");
      expect(progress.style.width).toBe("0%");
      expect(screen.button("Pause recording.webm")).toHaveProperty("disabled", false);
      await screen.rerender(preview(true));
      expect(screen.text()).toContain("Unavailable");
      await click(screen.button("Audio unavailable. Open recording.webm"));
      expect(onOpen).toHaveBeenCalledOnce();
    },
  );

  it.each(["pause", "error"])("unpins audio after %s", async (event) => {
    const NativeObserver = IntersectionObserver;
    using _observer = stubGlobal(
      "IntersectionObserver",
      class extends NativeObserver {
        constructor(
          private readonly notify: IntersectionObserverCallback,
          options?: IntersectionObserverInit,
        ) {
          super(notify, options);
        }
        override observe(target: Element) {
          this.notify([{ target, isIntersecting: true } as IntersectionObserverEntry], this);
        }
      },
    );
    const src =
      "data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA";
    audioAsset.url = src;
    onTestFinished(() => {
      audioAsset.url = "";
    });
    const props = baseProps();
    await using screen = await renderTimeline(
      [
        // The first message row is always mounted, so the recordings go in the second.
        message("Start of the thread.", { role: "user" }, "opening"),
        message(
          "Two recordings.",
          {
            attachments: ["one", "two"].map((name) => ({
              type: "file",
              id: `attachment-${name}`,
              name: `${name}.wav`,
              mimeType: "audio/wav",
              sizeBytes: 45,
              previewUrl: src,
            })),
          },
          "audio",
        ),
        ...Array.from({ length: 40 }, (_, index) =>
          message("Conversation history. ".repeat(40), { role: "user" }, `history-${index}`),
        ),
      ],
      props,
    );
    screen.container.style.height = "600px";
    screen.container.scrollIntoView({ block: "start" });
    await vi.waitFor(
      async () => {
        await act(() => {
          void props.listRef.current?.scrollToIndex({ index: 1, animated: false });
        });
        expect(screen.container.querySelectorAll("audio")).toHaveLength(2);
      },
      { timeout: 5000 },
    );
    const [one, two] = [...screen.container.querySelectorAll("audio")];
    await act(async () => {
      vi.spyOn(one!, "paused", "get").mockReturnValue(false);
      vi.spyOn(two!, "paused", "get").mockReturnValue(false);
      one!.dispatchEvent(new Event("play"));
      two!.dispatchEvent(new Event("play"));
    });
    await vi.waitFor(async () => {
      await act(() => {
        void props.listRef.current!.scrollToEnd({ animated: false });
      });
      const scroll = props.listRef.current!.getScrollableNode()!;
      expect(scroll.scrollTop).toBeGreaterThan(5000);
    });
    expect(one!.isConnected).toBe(true);
    expect(two!.isConnected).toBe(true);
    await act(async () => {
      vi.spyOn(one!, "paused", "get").mockReturnValue(true);
      one!.dispatchEvent(new Event("pause"));
    });
    expect(two!.isConnected).toBe(true);
    await act(async () => {
      if (event === "pause") vi.spyOn(two!, "paused", "get").mockReturnValue(true);
      two!.dispatchEvent(new Event(event));
    });
    await act(() => {
      void props.listRef.current!.scrollToIndex({ index: 20, animated: false });
    });
    await vi.waitFor(() => expect(one!.isConnected).toBe(false));
  });
});

describe("MessagesTimeline thread find", () => {
  // Opening find is navigation; on a list already showing the thread the open
  // action navigates, so the list itself releases follow only when it starts
  // showing a thread whose find is already open.
  function renderObserved() {
    const navigations: TimelineNavigation[] = [];
    const base = baseProps();
    const element = (next: Partial<TimelineProps>) => (
      <MessagesTimeline
        {...base}
        timelineEntries={[message("Where is the sidebar fix?")]}
        onViewportAttach={(viewport) =>
          viewport.subscribe((navigation) => navigations.push(navigation))
        }
        {...next}
      />
    );
    return { navigations, element };
  }
  const released = { source: "command", releasesFollow: true };

  it("releases follow once when it starts showing a thread whose find is open", async () => {
    const { navigations, element } = renderObserved();
    await using screen = await renderElement(element({}));
    expect(navigations).toEqual([]);

    const other = "environment-local:thread-find-open";
    await screen.rerender(element({ routeThreadKey: other, findOpen: true }));
    expect(navigations).toEqual([released]);
    await screen.rerender(element({ routeThreadKey: other, findOpen: false }));
    await screen.rerender(element({ routeThreadKey: other, findOpen: true }));
    expect(navigations).toEqual([released]);
  });

  it("releases follow once when it mounts on a thread whose find is open", async () => {
    const { navigations, element } = renderObserved();
    await using screen = await renderElement(element({ findOpen: true }));
    await screen.rerender(element({ findOpen: true }));
    expect(navigations).toEqual([released]);
  });

  it("still restores the position of a thread it switches to whose find is open", async () => {
    const base = baseProps();
    const other = "environment-local:thread-find-open-positioned";
    const replies = Array.from({ length: 40 }, (_, index) =>
      message(`Reply ${index}\n\n${"line\n\n".repeat(8)}`, { role: "assistant" }, `r-${index}`),
    );
    rememberTimelinePosition(
      other,
      { rowId: "entry-r-20", offsetWithinRow: 0, scrollOffset: 0, atEnd: false },
      false,
    );
    await using screen = await renderElement(
      <MessagesTimeline {...base} timelineEntries={[message("Short thread")]} />,
    );
    await screen.rerender(
      <MessagesTimeline
        {...base}
        routeThreadKey={other}
        timelineEntries={replies}
        liveFollowEnabled={false}
        findOpen
      />,
    );
    const viewport = base.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => {
      const row = screen.container.querySelector('[data-timeline-row-id="entry-r-20"]');
      expect(row).not.toBeNull();
      expect(
        Math.abs(row!.getBoundingClientRect().top - viewport.getBoundingClientRect().top),
      ).toBeLessThanOrEqual(2);
    });
  });
  it("reveals find's match, not the remembered row, on a thread it switches to", async () => {
    const base = baseProps();
    const other = "environment-local:thread-find-open-match";
    const replies = Array.from({ length: 40 }, (_, index) =>
      message(
        `${index === 5 ? "Needle here" : `Reply ${index}`}\n\n${"line\n\n".repeat(8)}`,
        { role: "assistant" },
        `r-${index}`,
      ),
    );
    rememberTimelinePosition(
      other,
      { rowId: "entry-r-20", offsetWithinRow: 0, scrollOffset: 0, atEnd: false },
      false,
    );
    await using screen = await renderElement(
      <MessagesTimeline {...base} timelineEntries={[message("Short thread")]} />,
    );
    await screen.rerender(
      <MessagesTimeline
        {...base}
        routeThreadKey={other}
        timelineEntries={replies}
        liveFollowEnabled={false}
        findOpen
        findExpanded
        findQuery="Needle"
        activeFindMatch={{ entryId: "entry-r-5", runId: null, occurrence: 0 }}
      />,
    );
    const viewport = base.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => {
      const row = screen.container.querySelector('[data-timeline-row-id="entry-r-5"]');
      expect(row).not.toBeNull();
      const bounds = viewport.getBoundingClientRect();
      const top = row!.getBoundingClientRect().top;
      expect(top).toBeGreaterThanOrEqual(bounds.top);
      expect(top).toBeLessThan(bounds.bottom);
    });
  });
});

describe("compact reasoning math", () => {
  it("keeps formulas while flattening compact reasoning previews", () => {
    const tree = parseMarkdownWithMath("## Reasoning\n\nUse **norm** $|x|$ and \\[x^2\\]");
    remarkThoughtPreview("Reasoning")(tree);
    expect(tree.children.map((node) => node.type)).toEqual([
      "text",
      "inlineMath",
      "text",
      "inlineMath",
    ]);
    expect(tree.children.map((node) => ("value" in node ? node.value : null))).toEqual([
      "Reasoning Use norm ",
      "|x|",
      " and ",
      "x^2",
    ]);
  });
});

it("renders automatic compaction as one live divider that finishes with its reason and token delta", async () => {
  const fixture = makeStreamingTimelineFixture();
  const prompt = fixture.visibleTurnItems[3]!;
  const assistant = fixture.visibleTurnItems[5]!;
  if (prompt.item.type !== "user_message" || assistant.item.type !== "assistant_message") {
    throw new Error("Expected streaming fixture messages");
  }
  const promptItem = prompt.item;
  const compaction = {
    ...assistant,
    item: {
      ...assistant.item,
      type: "compaction" as const,
      driver: null,
      beforeTokenCount: 899_000,
    },
  };
  const entries = (completed: boolean) =>
    deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          ...prompt,
          item: { ...promptItem, text: "/compact", idleCompaction: "beforeCacheExpires" },
        },
        {
          ...compaction,
          item: {
            ...compaction.item,
            status: completed ? "completed" : "running",
            afterTokenCount: completed ? 19_000 : undefined,
          },
        },
      ],
      optimisticMessages: [],
    });
  const props = baseProps();
  const ui = (completed: boolean) => (
    <MessagesTimeline
      {...props}
      timelineEntries={entries(completed)}
      isWorking={!completed}
      isCompacting={!completed}
      activeTurnStartedAt={fixture.time(5)}
      latestRun={{
        runId: fixture.runId,
        status: completed ? "completed" : "running",
        startedAt: fixture.time(5),
        completedAt: completed ? fixture.time(9) : null,
      }}
    />
  );
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  await using screen = await render(ui(false), { container });
  await expect
    .element(screen.getByRole("separator", { name: "Compacting before the cache expires…" }))
    .toBeVisible();
  expect(container.textContent).not.toContain("/compact");
  expect(container.textContent).not.toContain("Thinking");
  expect(container.textContent).not.toContain("Working");
  expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
  await screen.rerender(ui(true));
  await expect
    .element(
      screen.getByRole("separator", {
        name: "Context automatically compacted before cache expiry 899K → 19K tokens",
      }),
    )
    .toBeVisible();
  expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
  expect(container.textContent).not.toContain("Compacting before");
});

const CITATION_REQUEST = {
  key: "activation-1",
  citation: {
    version: 1,
    environmentId: ENVIRONMENT_ID,
    threadId: ThreadId.make("thread-cited"),
    messageId: MessageId.make("cited"),
    text: "the cited answer",
    start: 0,
    end: 16,
    prefix: "",
    suffix: "",
  },
} satisfies NonNullable<TimelineProps["citationRequest"]>;

describe("MessagesTimeline citations", () => {
  it("lands a citation present at mount under StrictMode", async () => {
    await using _screen = await renderElement(
      <StrictMode>
        <MessagesTimeline
          {...baseProps()}
          timelineEntries={[
            message("A question", {}, "question"),
            message("the cited answer", { role: "assistant" }, "cited"),
          ]}
          citationRequest={CITATION_REQUEST}
          citationHistory={{ _tag: "found" }}
        />
      </StrictMode>,
      // The test router mounts route content without StrictMode's effect replay.
      { router: false },
    );
    // StrictMode replays effect cleanups on mount; the activation must survive them.
    await vi.waitFor(() =>
      expect(document.querySelector("[data-citation-highlighted]")?.textContent).toContain(
        "the cited answer",
      ),
    );
  });

  it("opens the superseded attempt that folds the cited response", async () => {
    const runId = RunId.make("run-steered");
    const attempt = (id: string, ordinal: number, status: "superseded" | "running") => ({
      id: RunAttemptId.make(id),
      runId,
      attemptOrdinal: ordinal,
      rootNodeId: `node-${id}` as never,
      status,
      completedAt: null,
    });
    const superseded = attempt("attempt-1", 1, "superseded");
    const active = attempt("attempt-2", 2, "running");
    const inAttempt = (entry: Entry, entryAttempt: typeof superseded): Entry => ({
      ...entry,
      attempt: entryAttempt,
    });
    await using _screen = await renderTimeline(
      [
        inAttempt(message("Build it", { runId }, "question"), superseded),
        inAttempt(message("the cited answer", { role: "assistant", runId }, "cited"), superseded),
        inAttempt(message("Change direction", { runId }, "steer"), active),
        inAttempt(message("Current response", { role: "assistant", runId }, "current"), active),
      ],
      {
        latestRun: { runId, status: "running", startedAt: CREATED_AT, completedAt: null },
        citationRequest: CITATION_REQUEST,
        citationHistory: { _tag: "found" },
      },
    );
    await vi.waitFor(() =>
      expect(document.querySelector("[data-citation-highlighted]")?.textContent).toContain(
        "the cited answer",
      ),
    );
  });

  it("waits for cited history to load before giving up on a response outside the window", async () => {
    using toast = vi.spyOn(toastManager, "add");
    const props = baseProps();
    const citationRequest = CITATION_REQUEST;
    const recent = message("A recent question", {}, "recent");
    const timeline = (entries: Entry[], citationHistory: CitedHistory) => (
      <MessagesTimeline
        {...props}
        timelineEntries={entries}
        citationRequest={citationRequest}
        citationHistory={citationHistory}
      />
    );
    await using screen = await renderElement(timeline([recent], { _tag: "loading" }));
    await expect.element(screen.getByText("A recent question")).toBeVisible();

    await screen.rerender(
      timeline([message("the cited answer", { role: "assistant" }, "cited"), recent], {
        _tag: "found",
      }),
    );
    await expect.element(screen.getByText("the cited answer")).toBeVisible();
    expect(toast).not.toHaveBeenCalled();
  });
});

it("keeps concurrent approvals actionable outside collapsed work and restores settled rows", async () => {
  const fixture = makeStreamingTimelineFixture();
  const source = fixture.visibleTurnItems[4]!;
  if (source.item.type !== "dynamic_tool") throw new Error("Expected fixture tool");
  const sourceItem = source.item;
  const commandRequest = RuntimeRequestId.make("command-approval");
  const appRequest = RuntimeRequestId.make("app-approval");
  const approvals: PendingApproval[] = [
    {
      requestId: commandRequest,
      requestKind: "command",
      createdAt: fixture.time(6),
      detail: "printf '" + "long-command ".repeat(80) + "'",
      reason: "Needs permission to run the command",
      fullAccessOverride: "ask_rule",
      responseCapability: "live",
    },
    {
      requestId: appRequest,
      requestKind: "permission",
      createdAt: fixture.time(6),
      detail: "Open the current tab",
      appName: "Safari",
      options: [
        { decision: "decline", label: "Deny" },
        { decision: "accept", label: "Allow once" },
        {
          decision: "acceptAlways",
          label: "Always allow Safari",
          warning: "Applies to future requests",
        },
      ],
      responseCapability: "live",
    },
  ];
  const entries = (completed = false) =>
    deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        { ...source, item: { ...sourceItem, status: completed ? "completed" : sourceItem.status } },
        ...approvals.map((approval, index) => ({
          ...source,
          position: source.position + index + 1,
          sourceItemId: TurnItemId.make(`approval-${index}`),
          item: {
            ...sourceItem,
            id: TurnItemId.make(`approval-${index}`),
            type: "approval_request" as const,
            status: completed ? ("completed" as const) : ("waiting" as const),
            requestId: approval.requestId,
            requestKind: approval.requestKind,
            prompt: approval.detail,
          },
        })),
      ],
      optimisticMessages: [],
    });
  const props = baseProps();
  const onRespondToApproval = vi.fn(async () => {});
  const ui = (overrides: Partial<TimelineProps> = {}) => (
    <MessagesTimeline
      {...props}
      timelineEntries={entries()}
      pendingApprovals={approvals}
      canOperateThread
      onRespondToApproval={onRespondToApproval}
      isWorking
      runningRunId={fixture.runId}
      {...overrides}
    />
  );
  await using screen = await renderElement(ui());
  await expect.element(screen.getByRole("group", { name: "Command approval" })).toBeVisible();
  await expect
    .element(screen.getByRole("group", { name: "App permission approval" }))
    .toBeVisible();
  await expect.element(screen.getByText(approvals[0]!.detail!, { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Needs permission to run the command")).toBeVisible();
  await vi.waitFor(() => {
    expect(
      getComputedStyle(screen.getByLabelText("Command", { exact: true }).element()).userSelect,
    ).toBe("text");
    expect(
      getComputedStyle(screen.getByText("Needs permission to run the command").element())
        .userSelect,
    ).toBe("text");
  });
  await expect.element(screen.getByText("Safari", { exact: true })).toBeVisible();
  await click(screen.button("Why am I being asked this?"));
  await expect.element(page.getByText(/an ask rule in the agent's own settings/)).toBeVisible();
  await click(screen.button("Why am I being asked this?"));
  await click(screen.buttons("More approval options")[1]!);
  await expect.element(page.getByRole("menuitem", { name: "Always allow Safari" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Always allow Safari" }).click();
  expect(onRespondToApproval).toHaveBeenLastCalledWith(appRequest, "acceptAlways");
  await click(screen.buttons("More approval options")[0]!);
  await expect.element(page.getByRole("menuitem", { name: "Cancel", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Always allow this session" }).click();
  expect(onRespondToApproval).toHaveBeenLastCalledWith(commandRequest, "acceptForSession");
  await click(screen.button("Decline"));
  expect(onRespondToApproval).toHaveBeenLastCalledWith(commandRequest, "decline");
  await click(screen.button("Allow once"));
  expect(onRespondToApproval).toHaveBeenLastCalledWith(appRequest, "accept");
  for (const timelineEntries of [entries(), []]) {
    await screen.rerender(
      ui({ timelineEntries, heldApprovalRequestIds: new Set([commandRequest]) }),
    );
    await expect
      .element(screen.getByRole("group", { name: "Command approval" }))
      .not.toBeInTheDocument();
    await vi.waitFor(() => expect(screen.buttons("Approve")).toHaveLength(0));
    await expect
      .element(screen.getByRole("button", { name: "Allow once", exact: true }))
      .toBeVisible();
    await screen.rerender(ui({ timelineEntries }));
    await expect.element(screen.getByRole("group", { name: "Command approval" })).toBeVisible();
    await vi.waitFor(() => expect(screen.buttons("Approve")).toHaveLength(1));
  }
  await screen.rerender(ui({ timelineEntries: [], isWorking: false }));
  await expect.element(screen.getByRole("group", { name: "Command approval" })).toBeVisible();
  await click(screen.button("Approve"));
  expect(onRespondToApproval).toHaveBeenLastCalledWith(commandRequest, "accept");
  await click(screen.button("Deny"));
  expect(onRespondToApproval).toHaveBeenLastCalledWith(appRequest, "decline");
  await screen.rerender(
    ui({
      timelineEntries: [],
      isWorking: false,
      pendingApprovals: [{ ...approvals[0]!, detail: "" }],
    }),
  );
  await expect
    .element(screen.getByLabelText("Command", { exact: true }))
    .toHaveTextContent("Command approval");
  await screen.rerender(ui({ canOperateThread: false }));
  await expect.element(screen.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await vi.waitFor(() =>
    expect(
      screen.buttons("More approval options").every((button) => button.hasAttribute("disabled")),
    ).toBe(true),
  );
  await screen.rerender(ui({ respondingRequestIds: [commandRequest] }));
  await expect.element(screen.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Allow once", exact: true }))
    .toBeEnabled();
  await screen.rerender(
    ui({ pendingApprovals: [{ ...approvals[0]!, responseCapability: "not_resumable" }] }),
  );
  await expect
    .element(screen.getByText("Provider process is gone. Interrupt or restart the run to respond."))
    .toBeVisible();
  await vi.waitFor(() => expect(screen.buttons("Approve")).toHaveLength(0));
  await screen.rerender(
    ui({ pendingApprovals: [], timelineEntries: entries(true), isWorking: false }),
  );
  await expect
    .element(screen.getByRole("group", { name: "Command approval" }))
    .not.toBeInTheDocument();
  await vi.waitFor(() => expect(screen.text()).not.toContain("Waiting for approval"));
  await screen.getByRole("button", { expanded: false }).click();
  await expect
    .element(screen.getByRole("button", { name: approvals[0]!.detail!, exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Open the current tab", exact: true }))
    .toBeVisible();
});
