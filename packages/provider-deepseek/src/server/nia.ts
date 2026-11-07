import { D4_AGENT_PREFIX, D4_AGENT_TOOLS } from "@d4research/provider-core/server/d4AgentPolicy";
import { isLoopbackEndpoint, type DeepSeekSettings } from "../settings.ts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { DeepSeekRequestError } from "./http.ts";

export interface NiaToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
export interface NiaMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string | null;
  readonly tool_calls?: readonly NiaToolCall[] | undefined;
  readonly tool_call_id?: string | undefined;
}
export interface NiaToolEvent {
  phase: "started" | "completed" | "failed" | "interrupted";
  callId: string;
  name: string;
  arguments?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}
export interface NiaRegistration {
  endpoint: string;
  headers?: Record<string, string>;
}

const decodeToolArguments = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeToolResult = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const isRequestError = Schema.is(DeepSeekRequestError);
const allowedTools = new Set<string>(D4_AGENT_TOOLS);

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESULT_CHARS = 32_768;
const MAX_ROUNDS = 12;
const MAX_CALLS_PER_ROUND = 32;
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (category: "configuration" | "transport" | "protocol" | "tools" | "context") => {
  throw new DeepSeekRequestError({ category });
};

async function readJson(response: Response) {
  if (!response.body) return fail("protocol");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BODY_BYTES) return fail("protocol");
      text += decoder.decode(next.value, { stream: true });
    }
    const parsed: unknown = JSON.parse(text + decoder.decode());
    return parsed;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function* sseData(response: Response): AsyncGenerator<string> {
  if (!response.body) return fail("protocol");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) buffer += decoder.decode();
      else {
        bytes += next.value.byteLength;
        if (bytes > MAX_BODY_BYTES) return fail("protocol");
        buffer += decoder.decode(next.value, { stream: true });
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") {
          if (data.length > 0) yield data.join("\n");
          data = [];
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (next.done) {
        if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
        if (data.length > 0) yield data.join("\n");
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

class McpClient {
  private id = 0;
  private sessionId: string | undefined;
  private protocolVersion = "2025-03-26";
  private registration: NiaRegistration;
  private signal: AbortSignal;
  private fetch: typeof globalThis.fetch;
  constructor(registration: NiaRegistration, signal: AbortSignal, fetch: typeof globalThis.fetch) {
    this.fetch = fetch;
    this.registration = registration;
    this.signal = signal;
  }

  async request(method: string, params?: Record<string, unknown>, notification = false) {
    this.signal.throwIfAborted();
    const id = ++this.id;
    const headers = new Headers(this.registration.headers);
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json, text/event-stream");
    if (this.sessionId) headers.set("Mcp-Session-Id", this.sessionId);
    if (method !== "initialize") headers.set("MCP-Protocol-Version", this.protocolVersion);
    const response = await this.fetch(this.registration.endpoint, {
      method: "POST",
      headers,
      signal: this.signal,
      redirect: "error",
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
    });
    if (!response.ok) return fail("tools");
    if (method === "initialize")
      this.sessionId = response.headers.get("Mcp-Session-Id") ?? undefined;
    if (notification) {
      await response.body?.cancel();
      return undefined;
    }
    const result = (value: unknown) => {
      if (
        !object(value) ||
        value.jsonrpc !== "2.0" ||
        value.id !== id ||
        "error" in value ||
        !object(value.result)
      ) {
        return fail("tools");
      }
      return value.result;
    };
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      for await (const data of sseData(response)) {
        const value: unknown = JSON.parse(data);
        if (object(value) && value.id === id) return result(value);
      }
      return fail("tools");
    }
    return result(await readJson(response));
  }

  async tools() {
    const initialized = await this.request("initialize", {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: "d4research-deepseek", version: "1" },
    });
    if (typeof initialized?.protocolVersion !== "string") return fail("tools");
    this.protocolVersion = initialized.protocolVersion;
    await this.request("notifications/initialized", undefined, true);
    const tools = new Map<
      string,
      { name: string; description: string; parameters: Record<string, unknown> }
    >();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 64; page++) {
      const listed = await this.request("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(listed?.tools)) return fail("tools");
      for (const tool of listed.tools) {
        if (!object(tool) || typeof tool.name !== "string") return fail("tools");
        if (!allowedTools.has(tool.name)) continue;
        if (!object(tool.inputSchema) || tool.inputSchema.type !== "object" || tools.has(tool.name))
          return fail("tools");
        tools.set(tool.name, {
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description : "",
          parameters: tool.inputSchema,
        });
      }
      if (listed.nextCursor === undefined) {
        if (tools.size === 0) return fail("tools");
        return tools;
      }
      if (
        typeof listed.nextCursor !== "string" ||
        !listed.nextCursor ||
        cursors.has(listed.nextCursor)
      )
        return fail("tools");
      cursor = listed.nextCursor;
      cursors.add(cursor);
    }
    return fail("tools");
  }
}

async function completion(
  config: DeepSeekSettings,
  messages: NiaMessage[],
  tools: Awaited<ReturnType<McpClient["tools"]>>,
  signal: AbortSignal,
  request: typeof globalThis.fetch,
) {
  const promptBytes = new TextEncoder().encode(
    JSON.stringify({ messages, tools: [...tools.values()] }),
  ).byteLength;
  if (promptBytes > MAX_REQUEST_BYTES) return fail("context");
  const response = await request(`${config.endpoint.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    redirect: "error",
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      tools: [...tools.values()].map((tool) => ({ type: "function", function: tool })),
      tool_choice: "auto",
      parallel_tool_calls: false,
      max_tokens: Math.min(4096, config.contextWindowTokens - 512),
    }),
  });
  if (!response.ok) return fail("transport");
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return fail("protocol");
  let text = "";
  let finish: string | undefined;
  let done = false;
  const calls = new Map<number, NiaToolCall>();
  let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let receivedUsage = false;
  for await (const data of sseData(response)) {
    signal.throwIfAborted();
    if (data === "[DONE]") {
      done = true;
      break;
    }
    const chunk: unknown = JSON.parse(data);
    if (!object(chunk) || !Array.isArray(chunk.choices)) return fail("protocol");
    if (chunk.usage !== undefined && chunk.usage !== null) {
      receivedUsage = true;
      if (!object(chunk.usage)) return fail("protocol");
      const value = chunk.usage;
      for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
        if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) return fail("protocol");
      }
      if (Number(value.total_tokens) > config.contextWindowTokens) return fail("context");
      usage = {
        prompt_tokens: Number(value.prompt_tokens),
        completion_tokens: Number(value.completion_tokens),
        total_tokens: Number(value.total_tokens),
      };
    }
    for (const choice of chunk.choices) {
      if (!object(choice)) return fail("protocol");
      if (choice.index !== undefined && choice.index !== 0) continue;
      if (!object(choice.delta)) return fail("protocol");
      if (typeof choice.finish_reason === "string") finish = choice.finish_reason;
      const delta = choice.delta;
      if (delta.function_call !== undefined) return fail("tools");
      if (delta.content !== undefined && delta.content !== null) {
        if (typeof delta.content !== "string") return fail("protocol");
        text += delta.content;
      }
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls)) return fail("protocol");
        for (const fragment of delta.tool_calls) {
          if (
            !object(fragment) ||
            !Number.isSafeInteger(fragment.index) ||
            Number(fragment.index) < 0 ||
            Number(fragment.index) >= MAX_CALLS_PER_ROUND
          )
            return fail("tools");
          const index = Number(fragment.index);
          const call = calls.get(index) ?? {
            id: "",
            type: "function" as const,
            function: { name: "", arguments: "" },
          };
          if (fragment.type !== undefined && fragment.type !== "function") return fail("tools");
          if (fragment.id !== undefined) {
            if (typeof fragment.id !== "string") return fail("protocol");
            call.id += fragment.id;
          }
          if (fragment.function !== undefined) {
            if (!object(fragment.function)) return fail("protocol");
            for (const key of ["name", "arguments"] as const) {
              const value = fragment.function[key];
              if (value !== undefined) {
                if (typeof value !== "string") return fail("protocol");
                call.function[key] += value;
              }
            }
          }
          calls.set(index, call);
        }
      }
    }
  }
  if (
    !receivedUsage ||
    !done ||
    (calls.size > 0 ? finish !== "tool_calls" : finish !== "stop" || text.trim() === "")
  )
    return fail("protocol");
  return {
    text,
    usage,
    calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call),
  };
}

/** Stands in for a tool result until the call is known to have finished. */
export const UNVERIFIED_TOOL_RESULT = '{"error":"tool_request_failed","completionVerified":false}';

type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

export const runNiaTurn = Effect.fn("DeepSeekNia.runTurn")(function* <E, R>(
  config: DeepSeekSettings,
  messages: ReadonlyArray<NiaMessage>,
  registration: NiaRegistration | undefined,
  onTool: (event: NiaToolEvent) => Effect.Effect<void, E, R>,
  externalSignal?: AbortSignal,
  onHistory?: (messages: NiaMessage[]) => Effect.Effect<void, E, R>,
  onUsage?: (usage: Usage) => void,
) {
  const request = yield* FetchHttpClient.Fetch;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      if (messages.some((message) => message.role === "system"))
        return yield* new DeepSeekRequestError({ category: "tools" });
      if (!isLoopbackEndpoint(config.endpoint))
        return yield* new DeepSeekRequestError({ category: "configuration" });
      if (
        !registration?.endpoint ||
        !Object.entries(registration.headers ?? {}).some(
          ([key, value]) => key.toLowerCase() === "authorization" && /^Bearer\s+\S+$/i.test(value),
        )
      )
        return yield* new DeepSeekRequestError({ category: "tools" });
      const scopedSignal = yield* Effect.abortSignal;
      const activeSignal = externalSignal
        ? AbortSignal.any([externalSignal, scopedSignal])
        : scopedSignal;
      const promise = <A>(action: () => Promise<A>) =>
        Effect.tryPromise({
          try: action,
          catch: (cause) =>
            isRequestError(cause)
              ? cause
              : new DeepSeekRequestError({ category: "protocol", cause }),
        });
      const checkAborted = () => promise(async () => activeSignal.throwIfAborted());
      const history: NiaMessage[] = [...messages];
      const ids = new Set<string>();
      yield* checkAborted();
      const mcp = new McpClient(registration, activeSignal, request);
      const tools = yield* promise(() => mcp.tools());
      for (let round = 0; round < MAX_ROUNDS; round++) {
        yield* checkAborted();
        const reply = yield* promise(() =>
          completion(
            config,
            [{ role: "system", content: D4_AGENT_PREFIX }, ...history],
            tools,
            activeSignal,
            request,
          ),
        );
        onUsage?.(reply.usage);
        if (reply.calls.length > 1) return yield* new DeepSeekRequestError({ category: "tools" });
        const validated: { call: NiaToolCall; args: Record<string, unknown> }[] = [];
        for (const call of reply.calls) {
          if (
            !call.id ||
            ids.has(call.id) ||
            !tools.has(call.function.name) ||
            !allowedTools.has(call.function.name)
          )
            return yield* new DeepSeekRequestError({ category: "tools" });
          ids.add(call.id);
          const args = yield* decodeToolArguments(call.function.arguments).pipe(
            Effect.mapError((cause) => new DeepSeekRequestError({ category: "tools", cause })),
          );
          validated.push({ call, args });
        }
        history.push({
          role: "assistant",
          content: reply.text || null,
          ...(reply.calls.length ? { tool_calls: reply.calls } : {}),
        });
        if (validated.length === 0) {
          if (onHistory) yield* onHistory([...history]);
          return { text: reply.text, usage: reply.usage, messages: history };
        }
        if (round === MAX_ROUNDS - 1) return yield* new DeepSeekRequestError({ category: "tools" });
        for (const { call, args } of validated) {
          yield* checkAborted();
          history.push({ role: "tool", content: UNVERIFIED_TOOL_RESULT, tool_call_id: call.id });
          const resultIndex = history.length - 1;
          let completed = false;
          yield* Effect.gen(function* () {
            // Persist the exact assistant call and placeholder before allowing the side effect.
            if (onHistory) yield* onHistory([...history]);
            yield* checkAborted();
            yield* onTool({
              phase: "started",
              callId: call.id,
              name: call.function.name,
              arguments: args,
            });
            yield* checkAborted();
            const result = yield* promise(() =>
              mcp.request("tools/call", { name: call.function.name, arguments: args }),
            );
            const raw = yield* encodeToolResult(result).pipe(
              Effect.mapError((cause) => new DeepSeekRequestError({ category: "protocol", cause })),
            );
            const output =
              raw.length > MAX_RESULT_CHARS
                ? `${raw.slice(0, MAX_RESULT_CHARS)}\n[TRUNCATED: maxCharacters=${MAX_RESULT_CHARS}]`
                : raw;
            history[resultIndex] = { role: "tool", content: output, tool_call_id: call.id };
            // Persist a successful result before a callback can cancel this turn.
            if (onHistory) yield* onHistory([...history]);
            completed = true;
            yield* onTool({
              phase: "completed",
              callId: call.id,
              name: call.function.name,
              result: output,
              isError: result?.isError === true,
            });
            yield* checkAborted();
          }).pipe(
            Effect.onError((cause) =>
              Effect.gen(function* () {
                if (onHistory) yield* onHistory([...history]).pipe(Effect.ignore);
                if (!completed)
                  yield* onTool({
                    phase:
                      activeSignal.aborted || Cause.hasInterrupts(cause) ? "interrupted" : "failed",
                    callId: call.id,
                    name: call.function.name,
                    result: UNVERIFIED_TOOL_RESULT,
                    isError: true,
                  }).pipe(Effect.ignore);
              }),
            ),
          );
        }
        if (onHistory) yield* onHistory([...history]);
      }
      return yield* new DeepSeekRequestError({ category: "tools" });
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: config.requestTimeoutMs,
      orElse: () => Effect.fail(new DeepSeekRequestError({ category: "timeout" })),
    }),
  );
});
