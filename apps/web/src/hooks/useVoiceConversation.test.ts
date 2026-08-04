import { describe, expect, it, vi } from "vite-plus/test";

import {
  isReadOriginalRequest,
  spokenExcerpt,
  summarizeReplyForSpeech,
  voiceConversationStatusCopy,
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
      waiting: { label: "Thinking", detail: "Waiting for T3Code to reply" },
      summarizing: {
        label: "Summarizing",
        detail: "Gemma is making the reply easier to listen to",
      },
      speaking: { label: "Speaking", detail: "Playing T3Code's reply locally" },
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
});
