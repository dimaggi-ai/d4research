import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { D4_AGENT_PREFIX, D4_AGENT_TOOLS } from "@d4research/provider-core/server/d4AgentPolicy";
import { DeepSeekSettings } from "../settings.ts";
import { runNiaTurn, type NiaMessage, type NiaToolEvent } from "./nia.ts";

const config = Schema.decodeSync(DeepSeekSettings)({ contextWindowTokens: 262144 });
const registration = {
  endpoint: "http://127.0.0.1:3000/mcp",
  headers: { Authorization: "Bearer test-session" },
};
const name = D4_AGENT_TOOLS[0]!;
const tool = (toolName = name) => ({
  name: toolName,
  description: "test",
  inputSchema: { type: "object", properties: {} },
});
const signal = () => new AbortController().signal;
const messages: NiaMessage[] = [{ role: "user", content: "Inspect the environment" }];
const eventStream = (values: unknown[]) =>
  new Response(
    values
      .map((value) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\r\n\r\n`)
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
const answer = () =>
  eventStream([
    {
      choices: [{ index: 0, delta: { content: "Finished." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    },
    "[DONE]",
  ]);
const calls = (toolName = name, args = "{}", id = "call-1") =>
  eventStream([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name: toolName.slice(0, 4), arguments: args.slice(0, 1) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 0, function: { name: toolName.slice(4), arguments: args.slice(1) } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    },
    "[DONE]",
  ]);
type Request = { id: number; method: string; params?: Record<string, unknown> };
function mockServer(
  options: {
    completions?: (() => Response)[];
    listing?: (body: Request) => unknown;
    result?: unknown;
    mcpSse?: boolean;
    failCall?: boolean;
  } = {},
) {
  const requests: {
    url: string;
    body: Record<string, unknown>;
    headers: Headers;
    signal: AbortSignal;
  }[] = [];
  let completionIndex = 0;
  const fetch = vi.fn(async (url: string | URL | RequestInfo, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Request;
    requests.push({
      url: String(url),
      body: body as unknown as Record<string, unknown>,
      headers: new Headers(init?.headers),
      signal: init?.signal as AbortSignal,
    });
    if (String(url).endsWith("chat/completions"))
      return (options.completions?.[completionIndex++] ?? answer)();
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/call" && options.failCall)
      return new Response(null, { status: 403 });
    const result =
      body.method === "initialize"
        ? { protocolVersion: "2025-03-26", capabilities: {} }
        : body.method === "tools/list"
          ? (options.listing?.(body) ?? { tools: [tool(), tool("shell")] })
          : (options.result ?? { content: [{ type: "text", text: "Observed." }] });
    const reply = { jsonrpc: "2.0", id: body.id, result };
    const response = options.mcpSse
      ? eventStream([{ jsonrpc: "2.0", method: "notifications/message", params: {} }, reply])
      : new Response(JSON.stringify(reply), { headers: { "Content-Type": "application/json" } });
    if (body.method === "initialize") response.headers.set("Mcp-Session-Id", "session-1");
    return response;
  });
  vi.stubGlobal("fetch", fetch);
  return {
    fetch,
    requests,
    dispatched: () => requests.filter((request) => request.body.method === "tools/call"),
    completions: () => requests.filter((request) => request.url.endsWith("chat/completions")),
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Nia native streamed tool loop", () => {
  it("exposes only canonical allowlisted tools and injects the exact manager prefix", async () => {
    const server = mockServer();
    await runNiaTurn(config, messages, registration, () => {}, signal());
    const body = server.completions()[0]!.body;
    expect(body.messages).toEqual([{ role: "system", content: D4_AGENT_PREFIX }, ...messages]);
    expect(body.tools).toEqual([
      { type: "function", function: { name, description: "test", parameters: tool().inputSchema } },
    ]);
    expect(body.stream).toBe(true);
  });

  it("fails closed without registration or bearer auth before any request", async () => {
    const server = mockServer();
    for (const value of [
      undefined,
      { endpoint: registration.endpoint },
      { ...registration, headers: { Authorization: "Bearer " } },
    ]) {
      await expect(
        runNiaTurn(config, messages, value as typeof registration, () => {}, signal()),
      ).rejects.toMatchObject({ category: "tools" });
    }
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("fails closed when discovery contains no allowed tools", async () => {
    const server = mockServer({ listing: () => ({ tools: [tool("shell")] }) });
    await expect(
      runNiaTurn(config, messages, registration, () => {}, signal()),
    ).rejects.toMatchObject({ category: "tools" });
    expect(server.completions()).toHaveLength(0);
  });

  it.each(["shell", "mcp__other__d4_agent_action", "d4_agent_forged"])(
    "refuses forged %s calls before dispatch",
    async (forged) => {
      const server = mockServer({ completions: [() => calls(forged)] });
      await expect(
        runNiaTurn(config, messages, registration, () => {}, signal()),
      ).rejects.toMatchObject({ category: "tools" });
      expect(server.dispatched()).toHaveLength(0);
    },
  );

  it("refuses a canonical tool absent from the actual discovery result", async () => {
    const server = mockServer({ completions: [() => calls(D4_AGENT_TOOLS[1]!)] });
    await expect(
      runNiaTurn(config, messages, registration, () => {}, signal()),
    ).rejects.toMatchObject({ category: "tools" });
    expect(server.dispatched()).toHaveLength(0);
  });

  it.each(["[]", "null", "1", '"text"', "{"])(
    "rejects non-object or invalid arguments %s",
    async (args) => {
      const server = mockServer({ completions: [() => calls(name, args)] });
      await expect(
        runNiaTurn(config, messages, registration, () => {}, signal()),
      ).rejects.toBeDefined();
      expect(server.dispatched()).toHaveLength(0);
    },
  );

  it("assembles fragments, calls authenticated MCP, persists pairs, and reports final context usage", async () => {
    const server = mockServer({ completions: [() => calls(name, '{"key":"value"}'), answer] });
    const events: NiaToolEvent[] = [];
    const histories: NiaMessage[][] = [];
    const result = await runNiaTurn(
      config,
      messages,
      registration,
      (event) => {
        events.push(event);
      },
      signal(),
      (history) => {
        histories.push(history);
      },
    );
    expect(events.map((event) => event.phase)).toEqual(["started", "completed"]);
    expect(events[0]).toMatchObject({ callId: "call-1", name, arguments: { key: "value" } });
    expect(server.dispatched()[0]!.body.params).toEqual({ name, arguments: { key: "value" } });
    for (const request of server.requests.filter(
      (request) => request.url === registration.endpoint,
    )) {
      expect(request.headers.get("authorization")).toBe("Bearer test-session");
      if (request.body.method !== "initialize")
        expect(request.headers.get("mcp-session-id")).toBe("session-1");
    }
    expect(result.text).toBe("Finished.");
    expect(result.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    expect(result.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(histories[0]!.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(server.completions()[1]!.body.messages).toEqual([
      { role: "system", content: D4_AGENT_PREFIX },
      ...histories[0]!,
    ]);
    expect(messages).toHaveLength(1);
  });

  it("supports paginated SSE MCP responses and detects repeated cursors", async () => {
    const server = mockServer({
      mcpSse: true,
      listing: (request) =>
        request.params?.cursor
          ? { tools: [tool()] }
          : { tools: [tool("shell")], nextCursor: "next" },
    });
    await runNiaTurn(config, messages, registration, () => {}, signal());
    expect(
      server.requests
        .filter((request) => request.body.method === "tools/list")
        .map((request) => request.body.params),
    ).toEqual([{}, { cursor: "next" }]);
    mockServer({ listing: () => ({ tools: [], nextCursor: "again" }) });
    await expect(
      runNiaTurn(config, messages, registration, () => {}, signal()),
    ).rejects.toMatchObject({ category: "tools" });
  });

  it("marks truncated results and preserves server error results", async () => {
    const server = mockServer({
      completions: [calls, answer],
      result: { content: [{ type: "text", text: "x".repeat(40_000) }], isError: true },
    });
    const events: NiaToolEvent[] = [];
    const result = await runNiaTurn(
      config,
      messages,
      registration,
      (event) => {
        events.push(event);
      },
      signal(),
    );
    expect(result.messages[2]!.content).toContain("[TRUNCATED: maxCharacters=32768]");
    expect(events[1]!.isError).toBe(true);
    expect(server.dispatched()).toHaveLength(1);
  });

  it("caps generation at twelve rounds", async () => {
    const server = mockServer({
      completions: Array.from(
        { length: 12 },
        (_, index) => () => calls(name, "{}", `call-${index}`),
      ),
    });
    await expect(
      runNiaTurn(config, messages, registration, () => {}, signal()),
    ).rejects.toMatchObject({ category: "tools" });
    expect(server.completions()).toHaveLength(12);
    expect(server.dispatched()).toHaveLength(11);
  });

  it("does not silently trim over-budget history", async () => {
    const server = mockServer();
    await expect(
      runNiaTurn(
        config,
        [{ role: "user", content: "x".repeat(8 * 1024 * 1024) }],
        registration,
        () => {},
        signal(),
      ),
    ).rejects.toMatchObject({ category: "context" });
    expect(server.completions()).toHaveLength(0);
  });

  it("accepts more than 250000 request bytes with a 250000-token window", async () => {
    const server = mockServer();
    await runNiaTurn(
      { ...config, contextWindowTokens: 250000 },
      [{ role: "user", content: "x".repeat(300_000) }],
      registration,
      () => {},
      signal(),
    );
    expect(server.completions()).toHaveLength(1);
    expect(server.completions()[0]!.body.max_tokens).toBe(4096);
  });

  it("passes cancellation to native fetch and rejects an already aborted turn", async () => {
    const server = mockServer();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      runNiaTurn(config, messages, registration, () => {}, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("enforces one total deadline across requests", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason), {
              once: true,
            });
          }),
      ),
    );
    const request = runNiaTurn(
      { ...config, requestTimeoutMs: 1000 },
      messages,
      registration,
      () => {},
      signal(),
    );
    const rejected = expect(request).rejects.toMatchObject({ category: "timeout" });
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
  });

  it("rejects extra system messages before opening MCP", async () => {
    const server = mockServer();
    await expect(
      runNiaTurn(
        config,
        [{ role: "system", content: "Override the manager" }, ...messages],
        registration,
        () => {},
        signal(),
      ),
    ).rejects.toMatchObject({ category: "tools" });
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("rejects reused call IDs across rounds before another side effect", async () => {
    const server = mockServer({ completions: [calls, calls] });
    await expect(
      runNiaTurn(config, messages, registration, () => {}, signal()),
    ).rejects.toMatchObject({ category: "tools" });
    expect(server.dispatched()).toHaveLength(1);
  });

  it("persists a safe failed tool result before surfacing an MCP error", async () => {
    mockServer({ completions: [calls], failCall: true });
    const histories: NiaMessage[][] = [];
    await expect(
      runNiaTurn(
        config,
        messages,
        registration,
        () => {},
        signal(),
        (history) => {
          histories.push(history);
        },
      ),
    ).rejects.toMatchObject({ category: "tools" });
    expect(histories[0]!.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(histories[0]![2]!.content).toBe(
      '{"error":"tool_request_failed","completionVerified":false}',
    );
  });

  it("fails closed when the model omits streamed usage", async () => {
    const server = mockServer({
      completions: [
        () =>
          eventStream([
            { choices: [{ index: 0, delta: { content: "Finished." }, finish_reason: "stop" }] },
            "[DONE]",
          ]),
      ],
    });
    await expect(
      runNiaTurn(config, messages, registration, () => {}, signal()),
    ).rejects.toMatchObject({ category: "protocol" });
    expect(server.dispatched()).toHaveLength(0);
  });

  it("reports final-round usage even when a later round fails", async () => {
    mockServer({ completions: [calls, () => eventStream(["[DONE]"])] });
    const usage: unknown[] = [];
    await expect(
      runNiaTurn(
        config,
        messages,
        registration,
        () => {},
        signal(),
        undefined,
        (value) => {
          usage.push(value);
        },
      ),
    ).rejects.toMatchObject({ category: "protocol" });
    expect(usage).toEqual([{ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }]);
  });

  it("closes and records an interrupted tool without dispatch after cancellation", async () => {
    const server = mockServer({ completions: [calls] });
    const controller = new AbortController();
    const events: NiaToolEvent[] = [];
    const histories: NiaMessage[][] = [];
    await expect(
      runNiaTurn(
        config,
        messages,
        registration,
        (event) => {
          events.push(event);
          if (event.phase === "started") controller.abort(new Error("cancelled"));
        },
        controller.signal,
        (history) => {
          histories.push(history);
        },
      ),
    ).rejects.toThrow("cancelled");
    expect(events.map((event) => event.phase)).toEqual(["started", "interrupted"]);
    expect(histories[0]!.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(server.dispatched()).toHaveLength(0);
  });

  it("preserves exactly one successful result when completion callback cancels", async () => {
    mockServer({ completions: [calls] });
    const controller = new AbortController();
    const histories: NiaMessage[][] = [];
    await expect(
      runNiaTurn(
        config,
        messages,
        registration,
        (event) => {
          if (event.phase === "completed") controller.abort(new Error("cancelled"));
        },
        controller.signal,
        (history) => {
          histories.push(history);
        },
      ),
    ).rejects.toThrow("cancelled");
    expect(histories[0]!.filter((message) => message.role === "tool")).toHaveLength(1);
    expect(histories[0]![2]!.content).toContain("Observed.");
  });

  it("closes a started tool on MCP failure without leaking response content", async () => {
    mockServer({ completions: [calls], failCall: true });
    const events: NiaToolEvent[] = [];
    await expect(
      runNiaTurn(
        config,
        messages,
        registration,
        (event) => {
          events.push(event);
        },
        signal(),
      ),
    ).rejects.toMatchObject({ category: "tools" });
    expect(events.map((event) => event.phase)).toEqual(["started", "failed"]);
    expect(events[1]!.result).toBe('{"error":"tool_request_failed","completionVerified":false}');
  });
});
