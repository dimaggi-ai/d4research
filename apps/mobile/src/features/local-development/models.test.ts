import { expect, it, vi } from "vite-plus/test";
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  TurboModuleRegistry: { get: () => null },
}));
import { appleModelAvailable, cloudGenerate, generateLocalTask } from "./models";
import { emptyWorkspace } from "./workspace";
it("never falls back from an unavailable on-device model to a cloud API", async () => {
  const request = vi.spyOn(globalThis, "fetch");
  expect(await appleModelAvailable()).toBe(false);
  await expect(
    generateLocalTask(emptyWorkspace(), "", "help", "secret", new AbortController().signal),
  ).rejects.toThrow("unavailable");
  expect(request).not.toHaveBeenCalled();
  request.mockRestore();
});
it("uses the explicit endpoint and key and does not leak API error response bodies", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ message: { content: '{"reply":"ok","edits":[]}' } }] }),
        { status: 200 },
      ),
    );
  expect(
    await cloudGenerate(
      "https://host/v1",
      "chosen-model",
      "private-key",
      [{ role: "user", content: "task" }],
      new AbortController().signal,
      request,
    ),
  ).toContain("ok");
  const [url, input] = request.mock.calls[0]!;
  expect(url).toBe("https://host/v1/chat/completions");
  expect(input?.redirect).toBe("error");
  expect(input?.headers).toEqual({
    "Content-Type": "application/json",
    Authorization: "Bearer private-key",
  });
  request.mockResolvedValue(new Response("private-key-provider-debug", { status: 401 }));
  await expect(
    cloudGenerate(
      "https://host/v1",
      "chosen-model",
      "private-key",
      [],
      new AbortController().signal,
      request,
    ),
  ).rejects.toThrow("HTTP 401");
});
it("rejects malformed and empty cloud responses", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"choices":[]}'));
  await expect(
    cloudGenerate("https://host/v1", "model", "", [], new AbortController().signal, request),
  ).rejects.toThrow("no text");
});
it("does not send API keys to an imported model", async () => {
  await expect(
    generateLocalTask(
      { ...emptyWorkspace(), mode: "gguf", modelUri: "file:///Bonsai-2.gguf" },
      "",
      "help",
      "cloud-key",
      new AbortController().signal,
    ),
  ).rejects.toThrow("custom runtime");
});
it("consumes Apple's cumulative stream snapshots and stops generation on abort", async () => {
  const listeners = {
    update: new Set<(event: { streamId: string; content: string }) => void>(),
    complete: new Set<(event: { streamId: string }) => void>(),
    error: new Set<(event: { streamId: string; error: string }) => void>(),
  };
  const native = {
    getConstants: () => ({}),
    isAvailable: () => true,
    generateStream: () => "stream-1",
    cancelStream: vi.fn(),
    onStreamUpdate: (callback: (event: { streamId: string; content: string }) => void) => {
      listeners.update.add(callback);
      return { remove: () => listeners.update.delete(callback) };
    },
    onStreamComplete: (callback: (event: { streamId: string }) => void) => {
      listeners.complete.add(callback);
      return { remove: () => listeners.complete.delete(callback) };
    },
    onStreamError: (callback: (event: { streamId: string; error: string }) => void) => {
      listeners.error.add(callback);
      return { remove: () => listeners.error.delete(callback) };
    },
  };
  const { TurboModuleRegistry } = await import("react-native");
  const mock = vi.spyOn(TurboModuleRegistry, "get").mockReturnValue(native);
  const complete = generateLocalTask(
    emptyWorkspace(),
    "",
    "help",
    "",
    new AbortController().signal,
  );
  listeners.update.forEach((callback) => callback({ streamId: "stream-1", content: '{"reply":' }));
  const response = '{"reply":"ok","edits":[]}';
  listeners.update.forEach((callback) => callback({ streamId: "stream-1", content: response }));
  listeners.complete.forEach((callback) => callback({ streamId: "stream-1" }));
  expect(await complete).toBe(response);
  expect(listeners.update.size).toBe(0);
  const abort = new AbortController();
  const stopped = generateLocalTask(emptyWorkspace(), "", "help", "", abort.signal);
  abort.abort();
  await expect(stopped).rejects.toThrow("stopped");
  expect(native.cancelStream).toHaveBeenCalledWith("stream-1");
  expect(listeners.complete.size).toBe(0);
  mock.mockRestore();
});
