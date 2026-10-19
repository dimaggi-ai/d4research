import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import { cloudEndpoint, type LocalWorkspace, modelMessages } from "./workspace";

type Messages = ReturnType<typeof modelMessages>;
interface AppleModelEvents {
  onStreamUpdate: (event: { streamId: string; content: string }) => void;
  onStreamComplete: (event: { streamId: string }) => void;
  onStreamError: (event: { streamId: string; error: string }) => void;
}
// Implemented by modules/t3-apple-llm on iOS 26+.
interface AppleModel {
  isAvailable(): boolean;
  generateStream(messages: Messages, options: { maxTokens: number; temperature: number }): string;
  cancelStream(id: string): void;
  addListener<E extends keyof AppleModelEvents>(
    event: E,
    listener: AppleModelEvents[E],
  ): { remove(): void };
}
const getAppleModel = () => requireOptionalNativeModule<AppleModel>("T3AppleLLM");
export async function appleModelAvailable() {
  if (Platform.OS !== "ios") return false;
  try {
    return getAppleModel()?.isAvailable() ?? false;
  } catch {
    return false;
  }
}
async function appleGenerate(messages: Messages, signal: AbortSignal) {
  const native = getAppleModel();
  if (!native?.isAvailable())
    throw new Error(
      "Apple Intelligence is unavailable. Enable it in iOS Settings on a supported device running iOS 26 or later.",
    );
  return new Promise<string>((resolve, reject) => {
    let text = "";
    let streamId: string | undefined;
    const listeners: Array<{ remove(): void }> = [];
    const cleanup = () => {
      listeners.forEach((listener) => listener.remove());
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      if (streamId) native.cancelStream(streamId);
      cleanup();
      reject(new Error("Generation stopped."));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    listeners.push(
      native.addListener("onStreamUpdate", (event) => {
        if (event.streamId === streamId) text = event.content;
      }),
    );
    listeners.push(
      native.addListener("onStreamComplete", (event) => {
        if (event.streamId === streamId) {
          cleanup();
          resolve(text);
        }
      }),
    );
    listeners.push(
      native.addListener("onStreamError", (event) => {
        if (event.streamId === streamId) {
          cleanup();
          reject(
            new Error(
              "The on-device model could not complete this task. Try a shorter conversation or file.",
            ),
          );
        }
      }),
    );
    try {
      streamId = native.generateStream(messages, { maxTokens: 1600, temperature: 0.2 });
    } catch {
      cleanup();
      reject(new Error("The on-device model could not start."));
    }
  });
}
export async function cloudGenerate(
  endpoint: string,
  model: string,
  apiKey: string,
  messages: Messages,
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  if (!model.trim()) throw new Error("Enter the API model name.");
  const response = await request(cloudEndpoint(endpoint), {
    method: "POST",
    signal,
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model: model.trim(), messages, stream: false, max_tokens: 2000 }),
  });
  if (!response.ok) throw new Error(`The API request failed (HTTP ${response.status}).`);
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("choices" in result) ||
    !Array.isArray(result.choices)
  )
    throw new Error("The API did not return an OpenAI-compatible response.");
  const text: unknown = result.choices[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("The API returned no text.");
  return text;
}
export async function generateLocalTask(
  workspace: LocalWorkspace,
  path: string,
  prompt: string,
  apiKey: string,
  signal: AbortSignal,
) {
  if (Platform.OS !== "ios") throw new Error("Local development mode is available only on iOS.");
  const messages = modelMessages(workspace, path, prompt);
  if (signal.aborted) throw new Error("Generation stopped.");
  if (workspace.mode === "cloud")
    return cloudGenerate(workspace.endpoint, workspace.model, apiKey, messages, signal);
  if (workspace.mode === "apple") return appleGenerate(messages, signal);
  if (!workspace.modelUri) throw new Error("Import a compatible GGUF model first.");
  // Bonsai 2's custom rotations and ternary kernels are absent from the stock runtime.
  if (/bonsai/i.test(workspace.modelUri))
    throw new Error(
      "Bonsai 2 requires PrismML's custom runtime. This build supports standard GGUF models and Apple Intelligence.",
    );
  const { initLlama } = await import("llama.rn");
  const context = await initLlama({
    model: workspace.modelUri,
    n_ctx: 4096,
    n_gpu_layers: 99,
    use_mmap: true,
  });
  const stop = () => {
    void context.stopCompletion().catch(() => undefined);
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) throw new Error("Generation stopped.");
    const result = await context.completion({
      messages,
      n_predict: 1600,
      temperature: 0.2,
      response_format: { type: "json_object" },
    });
    if (signal.aborted) throw new Error("Generation stopped.");
    return result.text;
  } finally {
    signal.removeEventListener("abort", stop);
    await context.release();
  }
}
