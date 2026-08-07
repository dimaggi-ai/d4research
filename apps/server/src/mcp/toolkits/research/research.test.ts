import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { RESEARCH_DELEGATION_BUDGET_PER_TURN, RESEARCH_STEP_VISIT_LIMIT } from "@t3tools/contracts";

import { ResearchDelegationBudget, ResearchDelegationBudgetLive } from "./budget.ts";
import { extractAssistantText, isColdStartProne, parseDelegateTarget } from "./handlers.ts";

const withBudget = <A>(
  body: (budget: ResearchDelegationBudget["Service"]) => Effect.Effect<A>,
): Promise<A> =>
  Effect.gen(function* () {
    const budget = yield* ResearchDelegationBudget;
    return yield* body(budget);
  }).pipe(Effect.provide(ResearchDelegationBudgetLive), Effect.runPromise);

describe("parseDelegateTarget", () => {
  it("splits on the first colon only, keeping colon-bearing models whole", () => {
    expect(parseDelegateTarget("claudeAgent:glm-5.2:cloud")).toEqual({
      instanceId: "claudeAgent",
      model: "glm-5.2:cloud",
    });
  });

  it("rejects malformed targets", () => {
    expect(parseDelegateTarget("claudeAgent")).toBeNull();
    expect(parseDelegateTarget(":model")).toBeNull();
    expect(parseDelegateTarget("claudeAgent:")).toBeNull();
  });
});

describe("extractAssistantText", () => {
  it("returns the codex agentMessage, not the echoed prompt or reasoning", () => {
    // Shape codex app-server thread/read returns: the echoed prompt and
    // intermediate reasoning share the turn with the real answer.
    const thread = {
      turns: [
        {
          items: [
            { type: "userMessage", content: [{ type: "text", text: "Reply with OK" }] },
            { type: "reasoning", content: ["thinking about it"] },
            { type: "agentMessage", text: "OK" },
          ],
        },
      ],
    };
    expect(extractAssistantText(thread)).toBe("OK");
  });

  it("is empty for an in-progress codex turn that has no agentMessage yet", () => {
    // The window the poll must not exit on: turn exists, answer does not.
    const thread = { turns: [{ items: [{ type: "userMessage", content: [] }] }] };
    expect(extractAssistantText(thread)).toBe("");
  });

  it("reads claude/opencode role+content blocks and skips the user turn", () => {
    const thread = {
      turns: [
        {
          items: [
            { role: "user", content: [{ type: "text", text: "question" }] },
            { role: "assistant", content: [{ type: "text", text: "answer" }] },
          ],
        },
      ],
    };
    expect(extractAssistantText(thread)).toBe("answer");
  });

  it("reads agy plain-string and { text } items", () => {
    expect(extractAssistantText({ turns: [{ items: ["hello ", { text: "world" }] }] })).toBe(
      "hello world",
    );
  });

  it("is empty when there are no turns", () => {
    expect(extractAssistantText({ turns: [] })).toBe("");
  });
});

describe("isColdStartProne", () => {
  it("flags Ollama cloud models so they get a warm-up turn", () => {
    expect(isColdStartProne("kimi-k2.7-code:cloud")).toBe(true);
    expect(isColdStartProne("glm-5.2:cloud")).toBe(true);
  });

  it("leaves warm hosted/local models on the fast path", () => {
    expect(isColdStartProne("claude-fable-5")).toBe(false);
    expect(isColdStartProne("gpt-5.6-terra")).toBe(false);
    expect(isColdStartProne("gemini-3.6-flash-high")).toBe(false);
  });
});

describe("ResearchDelegationBudget", () => {
  it("cuts a step→target loop at the visit limit while other steps continue", () =>
    withBudget((budget) =>
      Effect.gen(function* () {
        const base = { threadId: "t1", target: "codex:gpt-5.6-terra", nowMs: 1_000 };
        for (let visit = 0; visit < RESEARCH_STEP_VISIT_LIMIT; visit++) {
          const charge = yield* budget.charge({ ...base, step: "3" });
          expect(charge.ok).toBe(true);
        }
        const cut = yield* budget.charge({ ...base, step: "3" });
        expect(cut.ok).toBe(false);
        expect(cut.reason).toContain('Step "3"');
        // Same target from a different step is a different loop.
        const otherStep = yield* budget.charge({ ...base, step: "4" });
        expect(otherStep.ok).toBe(true);
      }),
    ));

  it("exhausts the per-run total and reports zero remaining", () =>
    withBudget((budget) =>
      Effect.gen(function* () {
        for (let call = 0; call < RESEARCH_DELEGATION_BUDGET_PER_TURN; call++) {
          const charge = yield* budget.charge({
            threadId: "t2",
            step: `step-${call}`,
            target: `provider:model-${call}`,
            nowMs: 1_000 + call,
          });
          expect(charge.ok).toBe(true);
        }
        const spent = yield* budget.charge({
          threadId: "t2",
          step: "extra",
          target: "provider:model-extra",
          nowMs: 5_000,
        });
        expect(spent.ok).toBe(false);
        expect(spent.remaining).toBe(0);
        expect(spent.reason).toContain("budget exhausted");
      }),
    ));

  it("tracks threads independently and resets after the idle window", () =>
    withBudget((budget) =>
      Effect.gen(function* () {
        const drain = { step: "1", target: "a:b" };
        for (let call = 0; call < RESEARCH_STEP_VISIT_LIMIT; call++) {
          yield* budget.charge({ threadId: "t3", ...drain, nowMs: 1_000 });
        }
        const cutT3 = yield* budget.charge({ threadId: "t3", ...drain, nowMs: 1_000 });
        expect(cutT3.ok).toBe(false);
        // A different thread is untouched.
        const freshThread = yield* budget.charge({ threadId: "t4", ...drain, nowMs: 1_000 });
        expect(freshThread.ok).toBe(true);
        // After the idle window the same thread starts a fresh run.
        const afterIdle = yield* budget.charge({
          threadId: "t3",
          ...drain,
          nowMs: 1_000 + 61 * 60 * 1000,
        });
        expect(afterIdle.ok).toBe(true);
      }),
    ));
});
