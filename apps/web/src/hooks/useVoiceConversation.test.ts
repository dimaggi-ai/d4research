import { describe, expect, it, vi } from "vite-plus/test";

import {
  isReadOriginalRequest,
  needsSpokenSummary,
  SPOKEN_SUMMARY_THRESHOLD_CHARS,
  spokenExcerpt,
  summarizeReplyForSpeech,
  voiceConversationStatusCopy,
  wavLevelEnvelope,
} from "./useVoiceConversation";

describe("isReadOriginalRequest", () => {
  it.each([
    "Read the original",
    "Please read the full answer",
    "Play the whole response",
    "Speak it verbatim",
  ])("handles %s locally", (transcript) => {
    expect(isReadOriginalRequest(transcript)).toBe(true);
  });

  it("does not intercept an ordinary provider request", () => {
    expect(isReadOriginalRequest("Please fix the original test failure")).toBe(false);
  });
});

describe("spokenExcerpt", () => {
  it("turns a formatted reply into a short spoken response", () => {
    expect(
      spokenExcerpt(
        "## Done\n\n- Open the [dashboard](https://example.com).\n- Local tests pass.\n\n```ts\nignored()\n```\nA third sentence is omitted.",
      ),
    ).toBe("Done Open the dashboard. Local tests pass.");
  });
});

describe("voiceConversationStatusCopy", () => {
  it("gives every conversation phase a touch-visible label and explanation", () => {
    expect(voiceConversationStatusCopy).toEqual({
      idle: { label: "Talk", detail: "Start a hands-free conversation" },
      listening: { label: "Listening", detail: "Speak naturally, then pause" },
      transcribing: {
        label: "Transcribing",
        detail: "Turning your voice into text locally",
      },
      waiting: { label: "Thinking", detail: "Waiting for d4research to reply" },
      summarizing: {
        label: "Summarizing",
        detail: "Gemma is making the reply easier to listen to",
      },
      speaking: { label: "Speaking", detail: "Playing d4research's reply locally" },
    });
  });
});

describe("summarizeReplyForSpeech", () => {
  it("uses the local listen-friendly summary", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: "The change is deployed and the tests pass." }), {
          status: 200,
        }),
    );

    await expect(
      summarizeReplyForSpeech("## Done\n\nA long formatted coding response.", {
        fetcher,
        gatewayUrl: "http://voice.local",
      }),
    ).resolves.toBe("The change is deployed and the tests pass.");
    expect(fetcher).toHaveBeenCalledWith(
      "http://voice.local/voice/summarize",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("falls back to the local excerpt when Gemma is unavailable", async () => {
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 502 }));
    await expect(
      summarizeReplyForSpeech("## Done\n\nThe local fallback still works.", {
        fetcher,
        gatewayUrl: "http://voice.local",
      }),
    ).resolves.toBe("Done The local fallback still works.");
  });

  it("skips the gateway when the preferred summarizer answers", async () => {
    const fetcher = vi.fn();
    await expect(
      summarizeReplyForSpeech("## Done\n\nA long reply.", {
        fetcher,
        summarize: async () => "I deployed it.",
      }),
    ).resolves.toBe("I deployed it.");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("needsSpokenSummary", () => {
  it("speaks short prose as is", () => {
    expect(needsSpokenSummary("All checks passed. Nothing needs you right now.")).toBe(false);
  });

  it("summarizes long prose, code and tables", () => {
    expect(needsSpokenSummary("word ".repeat(SPOKEN_SUMMARY_THRESHOLD_CHARS / 4))).toBe(true);
    expect(needsSpokenSummary("Done.\n\n```ts\nconst a = 1;\n```")).toBe(true);
    expect(needsSpokenSummary("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(true);
  });
});

describe("wavLevelEnvelope", () => {
  function wav(samples: number[], sampleRate = 1000): ArrayBuffer {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const ascii = (offset: number, value: string) =>
      [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
    ascii(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, samples.length * 2, true);
    samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
    return buffer;
  }

  it("measures loudness per 40 ms window relative to the loudest window", () => {
    const quiet = Array.from({ length: 40 }, () => 1000);
    const loud = Array.from({ length: 40 }, () => 8000);
    const silence = Array.from({ length: 40 }, () => 0);
    const envelope = wavLevelEnvelope(wav([...quiet, ...loud, ...silence]));
    expect(Array.from(envelope ?? [])).toEqual([0.125, 1, 0]);
  });

  it("rejects audio it cannot read", () => {
    expect(wavLevelEnvelope(new ArrayBuffer(64))).toBeNull();
  });
});
