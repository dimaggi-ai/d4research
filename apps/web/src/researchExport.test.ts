import { EventId, MessageId, ProviderInstanceId, TurnId } from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildResearchMarkdownExport, researchMarkdownFilename } from "./researchExport";

describe("research Markdown export", () => {
  it("exports the latest result, provenance, clean transcript, and lifecycle evidence", () => {
    const markdown = buildResearchMarkdownExport({
      title: "Kitten fluffiness: evidence review",
      project: "d4research",
      environmentId: "env-local",
      threadId: "thread-1",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
      latestTurn: {
        turnId: TurnId.make("turn-1"),
        state: "completed",
        requestedAt: "2026-08-11T20:00:00.000Z",
        startedAt: "2026-08-11T20:00:01.000Z",
        completedAt: "2026-08-11T20:00:02.000Z",
        assistantMessageId: MessageId.make("message-2"),
      },
      messages: [
        {
          id: MessageId.make("message-1"),
          role: "user",
          text: 'Research this.\n\n<pasted_context version="2">\n{"name":"corpus.md","contentLength":4}\nsoft\n</pasted_context>\n\n<enabled_skills version="2" names="%5B%22review%22%5D" session-names="%5B%22review%22%5D">\n- "review" (this chat)\n</enabled_skills>',
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-08-11T20:00:00.000Z",
          updatedAt: "2026-08-11T20:00:00.000Z",
        },
        {
          id: MessageId.make("message-2"),
          role: "assistant",
          text: "## Findings\n\nThe evidence is bounded.\n\n## Uncertainty\n\nSample only.",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: "2026-08-11T20:00:02.000Z",
          updatedAt: "2026-08-11T20:00:02.000Z",
        },
      ],
      activities: [
        {
          id: EventId.make("event-manifest"),
          tone: "info",
          kind: "research.run.started",
          summary: "Research scenario starter started",
          payload: {
            scenario: "starter",
            pipelineHash: "a".repeat(64),
            budget: { maxDelegations: 24, maxVisitsPerStep: 3 },
            steps: [
              { number: 1, title: "Scope the question", delegation: "local", targets: [] },
              {
                number: 4,
                title: "Delegate review",
                delegation: "skipped-no-target",
                targets: [],
              },
            ],
            targets: [],
          },
          turnId: null,
          createdAt: "2026-08-11T20:00:00.000Z",
        },
        {
          id: EventId.make("event-1"),
          tone: "info",
          kind: "thread.turn.completed",
          summary: "Turn completed",
          payload: {},
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-08-11T20:00:02.000Z",
        },
      ],
      exportedAt: "2026-08-11T20:01:00.000Z",
    });

    expect(markdown).toContain("## Research result");
    expect(markdown).toContain("## Findings");
    expect(markdown).toContain("## Run provenance");
    expect(markdown).toContain("Current provider instance: `codex`");
    expect(markdown).toContain("## Research run manifest");
    expect(markdown).toContain("Pipeline SHA-256: `aaaaaaaa");
    expect(markdown).toContain("delegate SKIPPED — no explicit target");
    expect(markdown).toContain("No delegate target was configured");
    expect(markdown).toContain("_Attached context: corpus.md_");
    expect(markdown).toContain("`thread.turn.completed` — Turn completed");
    expect(markdown).not.toContain("<enabled_skills");
    expect(markdown).not.toContain("<pasted_context");
  });

  it("builds a stable filesystem-safe filename", () => {
    expect(researchMarkdownFilename("  Evidence / Cats?  ")).toBe("evidence-cats.md");
    expect(researchMarkdownFilename("!!!")).toBe("research-thread.md");
  });
});
