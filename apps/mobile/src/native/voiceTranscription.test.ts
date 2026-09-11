import { describe, expect, it } from "vite-plus/test";

import { getLocalVoiceTranscriber } from "./voiceTranscription";

describe("mobile native voice transcription boundary", () => {
  it("reports the native transcriber as unavailable instead of exposing a nonfunctional adapter", () => {
    expect(getLocalVoiceTranscriber()).toBeNull();
  });
});
