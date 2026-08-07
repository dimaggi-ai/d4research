import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { RESEARCH_DELEGATION_BUDGET_PER_TURN, RESEARCH_STEP_VISIT_LIMIT } from "@t3tools/contracts";

import { ResearchDelegationBudget, ResearchDelegationBudgetLive } from "./budget.ts";
import { parseDelegateTarget } from "./handlers.ts";

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
