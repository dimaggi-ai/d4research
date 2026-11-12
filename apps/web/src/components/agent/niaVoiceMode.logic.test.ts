import type { D4AgentTranscriptEntry } from "@d4research/contracts";
import { ThreadId } from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";

import { niaVoiceArtifacts } from "./niaVoiceMode.logic";

function entry(
  text: string,
  overrides: Partial<D4AgentTranscriptEntry> = {},
): D4AgentTranscriptEntry {
  return {
    id: "reply",
    role: "assistant",
    text,
    context: "Global",
    createdAt: "2026-11-12T09:00:00.000Z",
    links: [],
    ...overrides,
  } as D4AgentTranscriptEntry;
}

describe("niaVoiceArtifacts", () => {
  it("collects threads, artifacts, links and file paths outside code blocks", () => {
    const threadId = ThreadId.make("thread-1");
    const artifacts = niaVoiceArtifacts(
      entry(
        [
          "Published the [release notes](https://claude.ai/artifact/abc123).",
          "Dashboard: https://grafana.example.com/d/voice.",
          "The report is in `/home/me/reports/voice.md` and [plan](~/notes/plan.txt).",
          "```sh\ncat /etc/ignored/file.conf https://ignored.example.com\n```",
          "Run `vp test` next.",
        ].join("\n"),
        { links: [{ label: "Fix orchestrator", threadId, projectId: null }] },
      ),
    );
    expect(artifacts.map(({ kind, key }) => ({ kind, key }))).toEqual([
      { kind: "thread", key: "thread:thread-1" },
      { kind: "artifact", key: "url:https://claude.ai/artifact/abc123" },
      { kind: "file", key: "file:~/notes/plan.txt" },
      { kind: "link", key: "url:https://grafana.example.com/d/voice" },
      { kind: "file", key: "file:/home/me/reports/voice.md" },
    ]);
    expect(artifacts[1]).toMatchObject({ label: "release notes" });
    expect(artifacts[3]).toMatchObject({ label: "grafana.example.com/d/voice" });
  });

  it("returns nothing for plain prose", () => {
    expect(niaVoiceArtifacts(entry("All three checks passed. Nothing needs you."))).toEqual([]);
  });
});
