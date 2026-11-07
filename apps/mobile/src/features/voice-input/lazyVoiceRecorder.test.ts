import { describe, expect, it, vi } from "vite-plus/test";

import { VoiceInputController } from "@d4research/client-runtime/voice-input";

import { createLazyVoiceRecorder, type VoiceRecordingInput } from "./lazyVoiceRecorder";

type Status = { readonly isFinished: boolean };
type State = { readonly isRecording: boolean };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createNativeRecorder(uri: string) {
  const listeners = new Set<(status: Status) => void>();
  // Like expo-audio on Android, preparing again requires a stop in between.
  let isPrepared = false;
  return {
    uri: null as string | null,
    prepared: uri,
    prepareToRecordAsync: vi.fn(async function (this: { uri: string | null; prepared: string }) {
      if (isPrepared) throw new Error("Recorder is already prepared");
      isPrepared = true;
      this.uri = this.prepared;
    }),
    record: vi.fn(),
    stop: vi.fn(async (): Promise<void> => {
      isPrepared = false;
    }),
    getStatus: vi.fn((): State => ({ isRecording: true })),
    addListener: vi.fn((_event: "recordingStatusUpdate", listener: (status: Status) => void) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    }),
    getAvailableInputs: vi.fn((): ReadonlyArray<VoiceRecordingInput> => [
      { uid: "car", name: "CarPlay", type: "CarAudio" },
      { uid: "built-in", name: "iPhone Microphone", type: "MicrophoneBuiltIn" },
    ]),
    setInput: vi.fn((_uid: string): void | Promise<void> => undefined),
    cancelInputSelection: vi.fn((): void => undefined),
    release: vi.fn(),
    emit: (status: Status) => listeners.forEach((listener) => listener(status)),
  };
}

function createHarness(
  selectInput?: (inputs: ReadonlyArray<VoiceRecordingInput>) => VoiceRecordingInput | null,
  configure?: (native: ReturnType<typeof createNativeRecorder>) => void,
) {
  const created: Array<ReturnType<typeof createNativeRecorder>> = [];
  const statuses: Status[] = [];
  const recorder = createLazyVoiceRecorder({
    getDestination: () => "local",
    create: () => {
      const native = createNativeRecorder(`file:///voice-${created.length}.m4a`);
      configure?.(native);
      created.push(native);
      return native;
    },
    onStatus: (status) => statuses.push(status),
    ...(selectInput ? { selectInput } : {}),
  });
  return { recorder, created, statuses };
}

describe("createLazyVoiceRecorder", () => {
  it("does not create a native recorder until a recording prepares", async () => {
    const { recorder, created } = createHarness();

    expect(recorder.uri).toBeNull();
    expect(recorder.getStatus()).toBeNull();
    await recorder.stop();
    recorder.release();
    expect(created).toHaveLength(0);

    await recorder.prepareToRecordAsync();
    recorder.record({ forDuration: 300 });

    expect(created).toHaveLength(1);
    expect(created[0]!.record).toHaveBeenCalledWith({ forDuration: 300 });
    expect(recorder.uri).toBe("file:///voice-0.m4a");
    expect(recorder.getStatus()).toEqual({ isRecording: true });
  });

  it("reuses one native recorder across recordings", async () => {
    const { recorder, created } = createHarness();

    await recorder.prepareToRecordAsync();
    await recorder.stop();
    await recorder.prepareToRecordAsync();

    expect(created).toHaveLength(1);
    expect(created[0]!.prepareToRecordAsync).toHaveBeenCalledTimes(2);
  });

  it("selects the preferred input after preparing, when the session lists inputs", async () => {
    const { recorder, created } = createHarness(
      (inputs) => inputs.find((input) => input.type === "MicrophoneBuiltIn") ?? null,
    );

    await recorder.prepareToRecordAsync();

    expect(created[0]!.setInput).toHaveBeenCalledWith("built-in");
  });

  it("switches between local live capture and an encoded file only for the next recording", async () => {
    let destination: "local" | "environment" = "local";
    const local = createNativeRecorder("file:///local.pcm");
    const nextLocal = createNativeRecorder("file:///next-local.pcm");
    const encoded = createNativeRecorder("file:///environment.m4a");
    const localRecorders = [local, nextLocal];
    const recorder = createLazyVoiceRecorder({
      getDestination: () => destination,
      create: (mode) => (mode === "local" ? localRecorders.shift()! : encoded),
      onStatus: () => {},
    });
    await recorder.prepareToRecordAsync();
    destination = "environment";
    expect(recorder.uri).toBe(local.prepared);
    await recorder.stop();
    await recorder.prepareToRecordAsync();
    expect(recorder.uri).toBe(encoded.prepared);
    expect(local.release).toHaveBeenCalledOnce();
    destination = "local";
    await recorder.stop();
    await recorder.prepareToRecordAsync();
    expect(recorder.uri).toBe(nextLocal.prepared);
    expect(encoded.release).toHaveBeenCalledOnce();
    recorder.release();
  });

  it("keeps the system input when none is preferred or the preferred one disconnects", async () => {
    const unpreferred = createHarness(() => null);
    await unpreferred.recorder.prepareToRecordAsync();
    expect(unpreferred.created[0]!.setInput).not.toHaveBeenCalled();

    const disconnected = createHarness((inputs) => inputs[1] ?? null);
    await disconnected.recorder.prepareToRecordAsync();
    await disconnected.recorder.stop();
    disconnected.created[0]!.setInput.mockImplementationOnce(() => {
      throw new Error("Preferred input not found");
    });
    await expect(disconnected.recorder.prepareToRecordAsync()).resolves.toBeUndefined();

    const timedOut = createHarness(
      (inputs) => inputs[1] ?? null,
      (native) => {
        native.setInput.mockImplementationOnce(() =>
          Promise.reject(new Error("Routing timed out")),
        );
      },
    );
    await expect(timedOut.recorder.prepareToRecordAsync()).resolves.toBeUndefined();
  });

  it("forwards status events until the recorder is released", async () => {
    const { recorder, created, statuses } = createHarness();
    await recorder.prepareToRecordAsync();
    const native = created[0]!;

    native.emit({ isFinished: true });
    recorder.release();
    native.emit({ isFinished: false });

    expect(statuses).toEqual([{ isFinished: true }]);
  });

  it("releases only after a pending stop settles and keeps the final uri", async () => {
    const { recorder, created } = createHarness();
    await recorder.prepareToRecordAsync();
    const native = created[0]!;
    const stopped = deferred();
    native.stop.mockReturnValueOnce(stopped.promise);

    const stopping = recorder.stop();
    recorder.release();
    await Promise.resolve();
    expect(native.release).not.toHaveBeenCalled();
    expect(recorder.uri).toBe("file:///voice-0.m4a");

    stopped.resolve();
    await stopping;
    await vi.waitFor(() => expect(native.release).toHaveBeenCalledTimes(1));
    expect(recorder.uri).toBe("file:///voice-0.m4a");
    expect(recorder.getStatus()).toBeNull();
  });

  it("releases after a failed stop and creates a fresh recorder for the next start", async () => {
    const { recorder, created } = createHarness();
    await recorder.prepareToRecordAsync();
    const first = created[0]!;
    first.stop.mockRejectedValueOnce(new Error("not recording"));

    await expect(recorder.stop()).rejects.toThrow("not recording");
    recorder.release();
    await vi.waitFor(() => expect(first.release).toHaveBeenCalledTimes(1));
    expect(() => recorder.record({ forDuration: 1 })).toThrow(
      "The voice recorder isn’t ready. Try again.",
    );

    await recorder.prepareToRecordAsync();
    expect(created).toHaveLength(2);
    expect(recorder.uri).toBe("file:///voice-1.m4a");
  });

  describe("with the voice input controller", () => {
    function createController(
      granted: boolean,
      selectInput?: (inputs: ReadonlyArray<VoiceRecordingInput>) => VoiceRecordingInput | null,
      configure?: (native: ReturnType<typeof createNativeRecorder>) => void,
    ) {
      const harness = createHarness(selectInput, configure);
      const deleted: string[] = [];
      const controller = new VoiceInputController({
        recorder: harness.recorder,
        getTranscriber: () => ({
          prepare: async () => ({ locale: "en-US", transcribe: async () => "text" }),
        }),
        requestPermission: async () => ({ granted, canAskAgain: true }),
        configureRecording: async () => undefined,
        releaseRecording: async () => undefined,
        deleteRecording: (uri) => deleted.push(uri),
        readDraft: () => ({
          ownerKey: "thread",
          text: "",
          selection: { start: 0, end: 0 },
          revision: 0,
        }),
        commitDraft: () => undefined,
        onStateChange: () => undefined,
      });
      return { ...harness, controller, deleted };
    }

    it("does not create a native recorder when microphone permission is denied", async () => {
      const { controller, created } = createController(false);

      await controller.start();

      expect(controller.currentState.phase).toBe("error");
      expect(created).toHaveLength(0);
    });

    it("stops, deletes, and releases the recorder created by a cancelled recording", async () => {
      const { controller, recorder, created, deleted } = createController(true);

      await controller.start();
      expect(controller.currentState.phase).toBe("recording");
      expect(created).toHaveLength(1);
      const native = created[0]!;

      controller.cancel();
      recorder.release();
      await vi.waitFor(() => expect(native.release).toHaveBeenCalledTimes(1));

      expect(native.stop).toHaveBeenCalledTimes(1);
      expect(deleted).toEqual(["file:///voice-0.m4a"]);
      expect(controller.currentState.phase).toBe("idle");
    });

    it("abandons a pending input route when dictation is canceled", async () => {
      const routing = Promise.withResolvers<void>();
      const { controller, created } = createController(
        true,
        (inputs) => inputs[1] ?? null,
        (native) => {
          // Expo drops the promise of a canceled coroutine function, so it never settles.
          native.setInput.mockImplementationOnce(() => {
            routing.resolve();
            return new Promise(() => undefined);
          });
        },
      );
      const starting = controller.start();
      await routing.promise;
      controller.cancel();
      await starting;
      expect(created[0]!.cancelInputSelection).toHaveBeenCalled();
      expect(controller.currentState.phase).toBe("idle");

      await controller.start();
      expect(controller.currentState.phase).toBe("recording");
    });
  });
});
