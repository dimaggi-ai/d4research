import { EnvironmentId } from "@d4research/contracts";
import { formatComposerContextReference } from "@d4research/shared/composerContextReferences";
import { isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { environmentContextRecord } from "~/lib/composerContextRecords";
import { EnvironmentContextChip } from "../EnvironmentContextChip";

// Vite's `?worker` import evaluates the worker script itself under Node, which needs `self`.
vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({ default: vi.fn() }));

const record = environmentContextRecord(EnvironmentId.make("environment-vps"), "Hetzner [vps]");
const reference = { kind: "environment", contextId: record.contextId, label: record.label };
const context = {
  reference,
  annotationImage: null,
  attachment: null,
  resolvedTheme: "dark" as const,
  copyMarkdown: formatComposerContextReference(reference),
  onExpandImage: () => {},
  onExpandVideo: () => {},
  onOpenFile: () => {},
};

describe("user message context presentation", () => {
  // The registry asserts every composer context kind at module load, so a missing handler
  // throws while the chat route's chunk loads and the app never renders.
  it("initializes the thread view the chat route renders", async () => {
    await expect(import("../ThreadRouteView")).resolves.toHaveProperty("ThreadRouteView");
  });

  it("renders a sent machine mention as a machine chip", async () => {
    const { userMessageContextPresentationRegistry } = await import("./MessagesTimeline");

    const chip = userMessageContextPresentationRegistry.render("environment", record, context);
    expect(isValidElement(chip)).toBe(true);
    expect((chip as ReactElement).type).toBe(EnvironmentContextChip);
    expect((chip as ReactElement).props).toEqual({ record, copyMarkdown: context.copyMarkdown });

    const missing = userMessageContextPresentationRegistry.render(
      "environment",
      undefined,
      context,
    );
    expect((missing as ReactElement).type).not.toBe(EnvironmentContextChip);
  });
});
