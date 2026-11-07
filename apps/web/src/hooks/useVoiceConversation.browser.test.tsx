import { act, render } from "../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { useVoiceConversation } from "./useVoiceConversation";

it("keeps the microphone open across renders and stops it when its conversation unmounts", async () => {
  const stopTrack = vi.fn();
  const stopRecorder = vi.fn();
  const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
  const originalMediaDevices = navigator.mediaDevices;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    state = "inactive";
    mimeType = "audio/webm";
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      stopRecorder();
    }
  }
  class Context {
    createAnalyser() {
      return { fftSize: 512, getFloatTimeDomainData: vi.fn() };
    }
    createMediaStreamSource() {
      return { connect: vi.fn() };
    }
    close() {
      return Promise.resolve();
    }
  }
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  const container = document.createElement("div");
  document.body.append(container);
  function Conversation({ revision }: { revision: number }) {
    const voice = useVoiceConversation({
      messages: [],
      onTranscript: () => true,
      onError: vi.fn(),
    });
    return (
      <button onClick={voice.toggleConversation}>
        {revision}:{voice.active ? voice.status : "idle"}
      </button>
    );
  }
  try {
    await using screen = await render(<Conversation revision={0} />, { container, router: false });
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toBe("0:listening");
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(stopTrack).not.toHaveBeenCalled();
    await screen.rerender(<Conversation revision={1} />);
    expect(container.textContent).toBe("1:listening");
    expect(stopTrack).not.toHaveBeenCalled();
    await screen.unmount();
    expect(stopTrack).toHaveBeenCalledOnce();
    expect(stopRecorder).toHaveBeenCalledOnce();
  } finally {
    container.remove();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: originalMediaDevices,
    });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
