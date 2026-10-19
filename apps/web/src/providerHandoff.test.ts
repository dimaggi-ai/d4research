import { describe, expect, it } from "@effect/vitest";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@d4research/client-runtime/connection";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@d4research/contracts";
import { appendEnabledSkillsContext } from "@d4research/shared/enabledSkillsContext";
import { extractTrailingProviderHandoffContext } from "@d4research/shared/providerHandoffPrompt";
import { vi } from "vite-plus/test";

import {
  buildProviderHandoffMemory,
  buildImmediateProviderHandoffMessage,
  buildProviderHandoffPrompt,
  buildProviderHandoffTranscript,
  buildStructuredHandoffTranscript,
  isProviderHandoffCandidate,
  persistProviderHandoffMemoryFallback,
  PROVIDER_HANDOFF_MEMORY_TIMEOUT_MS,
  prepareDurableProviderHandoff,
  prepareProviderHandoff,
  PROVIDER_HANDOFF_PREPARE_TIMEOUT_MS,
  runSameThreadProviderHandoffTransition,
  shouldBypassProviderHandoffCompression,
  shouldHandoffModelSelection,
} from "./providerHandoff";

function preparedConnection(
  httpBaseUrl = "http://localhost",
  httpAuthorization: PreparedConnection["httpAuthorization"] = null,
): PreparedConnection {
  const environmentId = EnvironmentId.make("handoff-test");
  return {
    environmentId,
    label: "Handoff test",
    httpBaseUrl,
    socketUrl: "ws://localhost/ws",
    httpAuthorization,
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Handoff test",
      httpBaseUrl,
      wsBaseUrl: "ws://localhost",
    }),
  };
}

describe("provider handoff", () => {
  const immediateContext = {
    sourceThreadId: "original-thread",
    sourceThreadTitle: "Original task",
    targetInstanceId: "codex",
    targetModel: "gpt-5.6-sol",
    targetLabel: "Codex",
    project: "project-a",
    enabledSkills: ["review"],
  };

  it("creates a sendable handoff synchronously with the instruction and context in one message", () => {
    const text = buildImmediateProviderHandoffMessage({
      promptText: "Continue the implementation",
      context: immediateContext,
      messages: [
        { role: "user", text: "Build a parser" },
        { role: "assistant", text: "Tokenizer is complete" },
      ],
    });
    expect(typeof text).toBe("string");
    expect(text).toContain("USER: Build a parser");
    expect(text).toContain("ASSISTANT: Tokenizer is complete");
    expect(text).toContain("original-thread");
    expect(text).toContain("review");
    expect(extractTrailingProviderHandoffContext(text).promptText).toBe(
      "Continue the implementation",
    );
  });

  it("preserves the original task and latest findings within the automatic context budget", () => {
    const text = buildImmediateProviderHandoffMessage({
      promptText: "Continue",
      context: immediateContext,
      messages: [
        { role: "user", text: "Keep the same thread" },
        { role: "assistant", text: "x".repeat(100_000) },
        { role: "user", text: "Latest finding: SQLite is authoritative" },
      ],
    });
    expect(text).toContain("Keep the same thread");
    expect(text).toContain("Latest finding: SQLite is authoritative");
    expect(text).toContain("omitted");
    expect(text.length).toBeLessThan(61_000);
  });

  it("reserves room for a long instruction without truncating it", () => {
    const promptText = "p".repeat(100_000);
    const text = buildImmediateProviderHandoffMessage({
      promptText,
      context: immediateContext,
      messages: [
        { role: "user", text: "Source task" },
        { role: "assistant", text: "x".repeat(60_000) },
      ],
    });
    expect(text.length).toBeLessThanOrEqual(120_000);
    expect(extractTrailingProviderHandoffContext(text).promptText).toBe(promptText);
    expect(text).toContain("Source task");
  });

  it("rejects a message with no context space rather than silently dropping the handoff", () => {
    expect(() =>
      buildImmediateProviderHandoffMessage({
        promptText: "p".repeat(120_000),
        context: immediateContext,
        messages: [],
      }),
    ).toThrow(/leave room for the handoff context/);
  });

  it("keeps source metadata and transcript isolated between threads", () => {
    const first = buildImmediateProviderHandoffMessage({
      promptText: "Original instruction",
      context: immediateContext,
      messages: [{ role: "user", text: "Original history" }],
    });
    const other = buildImmediateProviderHandoffMessage({
      promptText: "Other instruction",
      context: { ...immediateContext, sourceThreadId: "other-thread" },
      messages: [{ role: "user", text: "Other history" }],
    });
    expect(first).toContain("original-thread");
    expect(first).not.toContain("Other history");
    expect(other).toContain("other-thread");
    expect(other).not.toContain("Original history");
  });
  it("never makes a handoff depend on compression by the provider being replaced", () => {
    expect(
      shouldBypassProviderHandoffCompression({
        requiredByWorkflow: false,
        sourceInstanceId: ProviderInstanceId.make("claude"),
        compressionBackend: "provider",
        compressionInstanceId: ProviderInstanceId.make("claude"),
      }),
    ).toBe(true);
    expect(
      shouldBypassProviderHandoffCompression({
        requiredByWorkflow: false,
        sourceInstanceId: ProviderInstanceId.make("claude"),
        compressionBackend: "provider",
        compressionInstanceId: ProviderInstanceId.make("ollama"),
      }),
    ).toBe(false);
    expect(
      shouldBypassProviderHandoffCompression({
        requiredByWorkflow: true,
        sourceInstanceId: ProviderInstanceId.make("claude"),
        compressionBackend: "local",
        compressionInstanceId: ProviderInstanceId.make("ollama"),
      }),
    ).toBe(true);
    expect(
      shouldBypassProviderHandoffCompression({
        requiredByWorkflow: false,
        sourceInstanceId: ProviderInstanceId.make("claude"),
        compressionBackend: "local",
        compressionInstanceId: null,
      }),
    ).toBe(false);
    expect(
      shouldBypassProviderHandoffCompression({
        requiredByWorkflow: false,
        sourceInstanceId: ProviderInstanceId.make("claude"),
        compressionBackend: "local",
        // Settings can retain the last provider selection when switching back
        // to local; that stale id must not disable the local compressor.
        compressionInstanceId: ProviderInstanceId.make("claude"),
      }),
    ).toBe(false);
  });

  it("persists first, then dispatches one receiving turn on the existing thread", async () => {
    const events: string[] = [];

    await runSameThreadProviderHandoffTransition({
      prepare: async () => {
        events.push("memo");
        return "handoff prompt";
      },
      startReceivingTurn: async (prompt) => {
        events.push(`start:${prompt}`);
      },
    });

    expect(events).toEqual(["memo", "start:handoff prompt"]);
  });

  it("does not stop or mutate the thread when durable preparation fails", async () => {
    const events: string[] = [];
    await expect(
      runSameThreadProviderHandoffTransition({
        prepare: async () => {
          events.push("memo-failed");
          throw new Error("memo unavailable");
        },
        startReceivingTurn: async () => {
          events.push("start");
        },
      }),
    ).rejects.toThrow("memo unavailable");
    expect(events).toEqual(["memo-failed"]);
  });

  it("does not issue a separate stop or metadata rollback when the atomic turn fails", async () => {
    const events: string[] = [];
    await expect(
      runSameThreadProviderHandoffTransition({
        prepare: async () => "handoff prompt",
        startReceivingTurn: async () => {
          events.push("atomic-start");
          throw new Error("receiver failed");
        },
      }),
    ).rejects.toThrow("receiver failed");
    expect(events).toEqual(["atomic-start"]);
  });

  it("passes a short thread through unchanged", () => {
    const transcript = buildStructuredHandoffTranscript(
      [
        { role: "user", text: "old context" },
        { role: "assistant", text: "latest result" },
      ],
      6_000,
    );
    expect(transcript).toBe("USER: old context\n\nASSISTANT: latest result");
    expect(transcript).not.toContain("omitted");
  });

  it("does not manufacture a continuation job when the handoff has no messages", () => {
    const transcript = buildProviderHandoffTranscript([]);

    expect(transcript).toBe(
      "No prior conversation messages were available for this context handoff.",
    );
    expect(transcript).not.toMatch(/continue|resume|unfinished work/i);
  });

  it("removes repeated enabled-skill transport from the handoff transcript", () => {
    const wrapped = appendEnabledSkillsContext("Fix the parser.", [
      {
        name: "focus-mode",
        path: "/skills/focus-mode/SKILL.md",
        scope: "session",
      },
    ]);
    const transcript = buildStructuredHandoffTranscript([
      { role: "user", text: wrapped },
      { role: "assistant", text: "Parser fixed." },
    ]);

    expect(transcript).toBe("USER: Fix the parser.\n\nASSISTANT: Parser fixed.");
    expect(transcript).not.toContain("<enabled_skills");
    expect(transcript).not.toContain("SKILL.md");
  });

  it("keeps the original task AND the newest messages on a long thread", () => {
    const messages = [
      { role: "user", text: "Original task: migrate the billing service to Effect v4." },
      ...Array.from({ length: 40 }, (_value, index) => ({
        role: index % 2 === 0 ? "assistant" : "user",
        text: `filler message ${index} ${"x".repeat(400)}`,
      })),
      { role: "assistant", text: "Final answer: the migration is complete." },
    ];
    const transcript = buildStructuredHandoffTranscript(messages, 3_000);
    expect(transcript).toContain("migrate the billing service to Effect v4");
    expect(transcript).toContain("USER (original task):");
    expect(transcript).toContain("earlier conversation");
    expect(transcript).toContain("Final answer: the migration is complete.");
    expect(transcript.length).toBeLessThanOrEqual(3_000);
  });

  it("preserves a dev pipeline task and its final run state across a stressed handoff", () => {
    const messages = [
      {
        role: "user",
        text: "!dev:repair fix provider fallback without changing the wire contract",
      },
      ...Array.from({ length: 80 }, (_, index) => ({
        role: index % 2 === 0 ? "assistant" : "user",
        text: `delegation ${index}: ${"context ".repeat(100)}`,
      })),
      {
        role: "assistant",
        text: "RUN STATE: plan PASS; build PASS; review PASS; verification `vp test run` PASS.",
      },
    ];

    const transcript = buildStructuredHandoffTranscript(messages, 4_000);
    expect(transcript).toContain("!dev:repair fix provider fallback");
    expect(transcript).toContain("RUN STATE: plan PASS");
    expect(transcript).toContain("earlier conversation compressed/omitted");
    expect(transcript.length).toBeLessThanOrEqual(4_000);
  });

  it("respects the character budget even when the first message is huge", () => {
    const messages = [
      { role: "user", text: "T".repeat(10_000) },
      { role: "assistant", text: "R".repeat(10_000) },
    ];
    const transcript = buildStructuredHandoffTranscript(messages, 1_000);
    expect(transcript.length).toBeLessThanOrEqual(1_000);
    expect(transcript).toContain("R");
  });

  it("uses the newest exact slice when even the omission marker cannot fit", () => {
    const transcript = buildStructuredHandoffTranscript(
      [
        { role: "user", text: "original task" },
        { role: "assistant", text: "newest result" },
      ],
      8,
    );
    expect(transcript).toBe("t result");
    expect(transcript).toHaveLength(8);
  });

  it("tells the receiving provider that shared Memo context is ready", () => {
    const prompt = buildProviderHandoffPrompt({
      sourceThreadId: ThreadId.make("thread-source"),
      sourceThreadTitle: "Voice integration",
      summary: "Voice is deployed and tests pass.",
      target: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet" },
      project: "t3code",
      enabledSkills: ["focus-mode", "security-review"],
    });
    expect(prompt).toContain("Context attached: local Memo");
    expect(prompt).toContain("stays in the same d4research chat");
    expect(prompt).toContain('memory_search with connector="local"');
    expect(prompt).toContain('project="t3code"');
    expect(prompt).toContain("thread-source");
    expect(prompt).toContain("authoritative conversation history");
    expect(prompt).toContain("Configured global and chat skills: focus-mode, security-review");
    expect(prompt).toContain("Keep these preferences after the handoff");
    expect(prompt).toContain(
      "This is context synchronization only, not a request to continue or resume any prior job or task.",
    );
    expect(prompt).toContain("Do not edit files, run tools, or advance prior work");
    expect(prompt).toMatch(/wait for the user's next instruction\.$/);
    expect(prompt).not.toContain("fresh d4research chat");
    expect(prompt).not.toContain("no prior transcript");
  });

  it("places the context-only guard after prior task text", () => {
    const prompt = buildProviderHandoffPrompt({
      sourceThreadId: ThreadId.make("thread-source"),
      sourceThreadTitle: "Completed deployment",
      summary: "Previous task: resume the deployment immediately. Status: already complete.",
      target: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    });

    expect(prompt.indexOf("resume the deployment immediately")).toBeGreaterThanOrEqual(0);
    expect(prompt.lastIndexOf("context synchronization only")).toBeGreaterThan(
      prompt.indexOf("resume the deployment immediately"),
    );
    expect(prompt).toMatch(/wait for the user's next instruction\.$/);
  });

  it("builds a self-contained shared-memory handoff record", () => {
    const memory = buildProviderHandoffMemory({
      sourceThreadId: ThreadId.make("thread-source"),
      sourceThreadTitle: "Voice integration",
      summary: "Voice is deployed and tests pass.",
      target: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet" },
      enabledSkills: ["focus-mode"],
    });
    expect(memory).toContain("thread-source");
    expect(memory).toContain("claude / claude-sonnet");
    expect(memory).toContain("Voice is deployed and tests pass.");
    expect(memory).toContain("Configured global and chat skills to preserve: focus-mode");
  });

  it("hands cross-agent model selections off after a session starts", () => {
    expect(
      shouldHandoffModelSelection({
        hasStartedSession: true,
        currentInstanceId: ProviderInstanceId.make("codex"),
        nextInstanceId: ProviderInstanceId.make("claude"),
        modelChangeRequiresNewThread: false,
        providerChanged: true,
      }),
    ).toBe(true);
    expect(
      shouldHandoffModelSelection({
        hasStartedSession: false,
        currentInstanceId: ProviderInstanceId.make("codex"),
        nextInstanceId: ProviderInstanceId.make("claude"),
        modelChangeRequiresNewThread: false,
        providerChanged: true,
      }),
    ).toBe(false);
  });

  it("accepts a custom maxCharacters for transcript building", () => {
    const messages = [
      { role: "user", text: "A".repeat(500) },
      { role: "assistant", text: "B".repeat(500) },
    ];
    const small = buildStructuredHandoffTranscript(messages, 400);
    expect(small).toContain("earlier conversation");
    expect(small.length).toBeLessThanOrEqual(400);

    const large = buildStructuredHandoffTranscript(messages, 50_000);
    expect(large).not.toContain("earlier conversation");
  });

  it("prepare client returns null on network failure", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("offline"));
    try {
      const result = await prepareProviderHandoff({
        transcript: "test transcript",
        preparedConnection: preparedConnection(),
      });
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("aborts a stuck prepare request at its bounded deadline", async () => {
    vi.useFakeTimers();
    const original = globalThis.fetch;
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }) as typeof globalThis.fetch;
    try {
      const result = prepareProviderHandoff({
        transcript: "context",
        preparedConnection: preparedConnection(),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(requestSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(PROVIDER_HANDOFF_PREPARE_TIMEOUT_MS);
      await expect(result).resolves.toBeNull();
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = original;
      vi.useRealTimers();
    }
  });

  it("aborts an in-flight prepare when the caller's signal fires", async () => {
    vi.useFakeTimers();
    const original = globalThis.fetch;
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }) as typeof globalThis.fetch;
    const caller = new AbortController();
    try {
      const result = prepareProviderHandoff({
        transcript: "context",
        preparedConnection: preparedConnection(),
        signal: caller.signal,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(requestSignal?.aborted).toBe(false);
      // The user backs out of the switch while it is still preparing.
      caller.abort();
      await expect(result).resolves.toBeNull();
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = original;
      vi.useRealTimers();
    }
  });

  it("prepare client returns null on non-ok response", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, compressed: "must not be trusted", memoryPersisted: true }),
          { status: 502 },
        ),
      );
    try {
      const result = await prepareProviderHandoff({
        transcript: "test transcript",
        preparedConnection: preparedConnection(),
      });
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("memo fallback posts to the memory route and reports the outcome", async () => {
    const original = globalThis.fetch;
    const calls: Array<string> = [];
    globalThis.fetch = (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    };
    try {
      const stored = await persistProviderHandoffMemoryFallback({
        text: "ctx",
        project: "p",
        preparedConnection: preparedConnection(),
      });
      expect(stored).toBe(true);
      expect(calls).toEqual(["http://localhost/api/memory/handoff"]);

      globalThis.fetch = () => Promise.reject(new Error("offline"));
      const failed = await persistProviderHandoffMemoryFallback({
        text: "ctx",
        preparedConnection: preparedConnection(),
      });
      expect(failed).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("prepare client preserves the summary and Memo persistence result", async () => {
    const original = globalThis.fetch;
    const calls: Array<string> = [];
    let postedBody: unknown;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      postedBody = JSON.parse(String(init?.body));
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, compressed: "dense summary", memoryPersisted: true }),
          { status: 200 },
        ),
      );
    }) as typeof globalThis.fetch;
    try {
      const result = await prepareProviderHandoff({
        transcript: "long transcript",
        project: "t3code",
        enabledSkills: ["focus-mode"],
        preparedConnection: preparedConnection(),
      });
      expect(result).toEqual({ summary: "dense summary", memoryPersisted: true });
      expect(calls).toEqual(["http://localhost/api/handoff/prepare"]);
      expect(postedBody).toMatchObject({ enabledSkills: ["focus-mode"] });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("routes both durable handoff writes to the environment that owns the thread", async () => {
    const original = globalThis.fetch;
    const calls: Array<{
      readonly url: string;
      readonly authorization: string | null;
      readonly credentials: RequestCredentials | undefined;
    }> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        credentials: init?.credentials,
      });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty("preparedConnection");
      if (String(input).endsWith("/api/handoff/prepare")) {
        return Promise.resolve(
          new Response(JSON.stringify({ ok: true, memoryPersisted: false }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as typeof globalThis.fetch;
    try {
      const summary = await prepareDurableProviderHandoff({
        transcript: "remote authoritative transcript",
        sourceThreadId: "remote-thread",
        sourceThreadTitle: "Remote thread",
        target: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
        preparedConnection: preparedConnection("http://100.64.0.40:43123/base-that-must-not-leak", {
          _tag: "Bearer",
          token: "remote-handoff-token",
        }),
      });
      expect(summary).toBe("remote authoritative transcript");
      expect(calls).toEqual([
        {
          url: "http://100.64.0.40:43123/api/handoff/prepare",
          authorization: "Bearer remote-handoff-token",
          credentials: undefined,
        },
        {
          url: "http://100.64.0.40:43123/api/memory/handoff",
          authorization: "Bearer remote-handoff-token",
          credentials: undefined,
        },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("uses the transcript without falling back to the browser host while disconnected", async () => {
    const original = globalThis.fetch;
    const fetcher = vi.fn<typeof fetch>();
    globalThis.fetch = fetcher;
    try {
      expect(await prepareProviderHandoff({ transcript: "remote transcript" })).toBeNull();
      expect(await persistProviderHandoffMemoryFallback({ text: "remote handoff memory" })).toBe(
        false,
      );
      await expect(
        prepareDurableProviderHandoff({
          transcript: "remote transcript",
          sourceThreadId: "remote-thread",
          sourceThreadTitle: "Disconnected remote thread",
          target: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
        }),
      ).resolves.toBe("remote transcript");
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("preserves a prepared summary when the local Memo write was not confirmed", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, compressed: "dense summary", memoryPersisted: false }),
          { status: 200 },
        ),
      );
    try {
      expect(
        await prepareProviderHandoff({
          transcript: "long transcript",
          preparedConnection: preparedConnection(),
        }),
      ).toEqual({ summary: "dense summary", memoryPersisted: false });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("uses the Memo fallback before allowing the same-thread handoff to continue", async () => {
    const original = globalThis.fetch;
    const calls: Array<string> = [];
    const bodies: Array<unknown> = [];
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)));
      if (String(input) === "http://localhost/api/handoff/prepare") {
        return Promise.resolve(
          new Response(
            JSON.stringify({ ok: true, compressed: "dense summary", memoryPersisted: false }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as typeof globalThis.fetch;
    try {
      const summary = await prepareDurableProviderHandoff({
        transcript: "authoritative transcript",
        project: "d4research",
        sourceThreadId: "thread-source",
        sourceThreadTitle: "One visible thread",
        target: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
        enabledSkills: ["focus-mode"],
        preparedConnection: preparedConnection(),
      });
      expect(summary).toBe("dense summary");
      expect(calls).toEqual([
        "http://localhost/api/handoff/prepare",
        "http://localhost/api/memory/handoff",
      ]);
      expect(bodies[0]).toMatchObject({ enabledSkills: ["focus-mode"] });
      expect(bodies[1]).toMatchObject({
        text: expect.stringContaining("Configured global and chat skills to preserve: focus-mode"),
      });
      expect((bodies[1] as { text: string }).text).toContain("dense summary");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps the handoff working when neither local Memo path can persist context", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            String(input) === "http://localhost/api/handoff/prepare"
              ? { ok: true, compressed: "dense summary", memoryPersisted: false }
              : { ok: false },
          ),
          {
            status: String(input) === "http://localhost/api/handoff/prepare" ? 200 : 503,
          },
        ),
      )) as typeof globalThis.fetch;
    try {
      await expect(
        prepareDurableProviderHandoff({
          transcript: "authoritative transcript",
          sourceThreadId: "thread-source",
          sourceThreadTitle: "One visible thread",
          target: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
          preparedConnection: preparedConnection(),
        }),
      ).resolves.toBe("dense summary");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("cancels a pending Memo fallback without waiting for its deadline", async () => {
    const original = globalThis.fetch;
    const controller = new AbortController();
    let fallbackSignal: AbortSignal | null = null;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (fetcher.mock.calls.length === 1) {
        return Promise.resolve(
          Response.json({ ok: true, compressed: "prepared context", memoryPersisted: false }),
        );
      }
      fallbackSignal = init?.signal ?? null;
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        fallbackSignal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });
    globalThis.fetch = fetcher as typeof fetch;
    try {
      const result = prepareDurableProviderHandoff({
        transcript: "original context",
        sourceThreadId: "source",
        sourceThreadTitle: "Source",
        target: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
        preparedConnection: preparedConnection(),
        signal: controller.signal,
      });
      await started;
      controller.abort();
      expect((fallbackSignal as AbortSignal | null)?.aborted).toBe(true);
      await expect(result).resolves.toBe("prepared context");
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not start a Memo write when already cancelled", async () => {
    const original = globalThis.fetch;
    const fetcher = vi.fn();
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = fetcher;
    try {
      await expect(
        persistProviderHandoffMemoryFallback({
          text: "context",
          preparedConnection: preparedConnection(),
          signal: controller.signal,
        }),
      ).resolves.toBe(false);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("removes cancellation listeners after a successful Memo write", async () => {
    const original = globalThis.fetch;
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    globalThis.fetch = fetcher;
    try {
      await expect(
        persistProviderHandoffMemoryFallback({
          text: "context",
          preparedConnection: preparedConnection(),
          signal: controller.signal,
        }),
      ).resolves.toBe(true);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      const init = fetcher.mock.calls[0] as unknown as [string, RequestInit];
      expect(JSON.parse(String(init[1].body))).toEqual({ text: "context" });
    } finally {
      remove.mockRestore();
      globalThis.fetch = original;
    }
  });

  it("aborts a stuck fallback write at its own bounded deadline", async () => {
    vi.useFakeTimers();
    const original = globalThis.fetch;
    let requestSignal: AbortSignal | undefined;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }) as typeof globalThis.fetch;
    try {
      const result = persistProviderHandoffMemoryFallback({
        text: "context",
        preparedConnection: preparedConnection(),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(requestSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(PROVIDER_HANDOFF_MEMORY_TIMEOUT_MS);
      await expect(result).resolves.toBe(false);
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = original;
      vi.useRealTimers();
    }
  });

  it("never offers the source provider as a handoff target", () => {
    const source = ProviderInstanceId.make("codex");
    expect(
      isProviderHandoffCandidate(
        { instanceId: source, enabled: true, isAvailable: true, status: "ready", models: [{}] },
        source,
      ),
    ).toBe(false);
    expect(
      isProviderHandoffCandidate(
        {
          instanceId: ProviderInstanceId.make("claude"),
          enabled: true,
          isAvailable: true,
          status: "ready",
          models: [{}],
        },
        source,
      ),
    ).toBe(true);
  });
});
