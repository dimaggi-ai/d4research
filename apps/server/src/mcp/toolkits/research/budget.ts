import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { RESEARCH_DELEGATION_BUDGET_PER_TURN, RESEARCH_STEP_VISIT_LIMIT } from "@t3tools/contracts";

/**
 * Hard server-side guard for research delegation loops. The orchestrator is
 * *instructed* to bound its own cycles, but a pipeline with a
 * summarize → argue → regenerate loop must terminate even when the model does
 * not: every `research_delegate` call burns budget here, and a step name can
 * only be charged `RESEARCH_STEP_VISIT_LIMIT` times per delegation target.
 *
 * State is keyed by orchestrator thread and expires after an idle window, so
 * one research run cannot starve the next one in the same thread.
 */
export interface ResearchBudgetCharge {
  readonly ok: boolean;
  readonly remaining: number;
  readonly reason?: string;
}

interface ThreadBudgetState {
  readonly lastChargeMs: number;
  readonly total: number;
  readonly perStepTarget: ReadonlyMap<string, number>;
}

const IDLE_RESET_MILLIS = 60 * 60 * 1000;

export class ResearchDelegationBudget extends Context.Service<
  ResearchDelegationBudget,
  {
    readonly charge: (input: {
      readonly threadId: string;
      readonly step: string;
      readonly target: string;
      readonly nowMs: number;
    }) => Effect.Effect<ResearchBudgetCharge>;
  }
>()("t3/mcp/toolkits/research/budget/ResearchDelegationBudget") {}

export const ResearchDelegationBudgetLive = Layer.effect(
  ResearchDelegationBudget,
  Effect.gen(function* () {
    const state = yield* Ref.make(new Map<string, ThreadBudgetState>());
    return {
      charge: ({ threadId, step, target, nowMs }) =>
        Ref.modify(
          state,
          (byThread): readonly [ResearchBudgetCharge, Map<string, ThreadBudgetState>] => {
            const previous = byThread.get(threadId);
            const fresh =
              previous === undefined || nowMs - previous.lastChargeMs > IDLE_RESET_MILLIS;
            const total = fresh ? 0 : (previous?.total ?? 0);
            const perStepTarget = fresh
              ? new Map<string, number>()
              : new Map(previous?.perStepTarget ?? []);
            const stepKey = `${step}→${target}`;
            const visits = perStepTarget.get(stepKey) ?? 0;

            if (total >= RESEARCH_DELEGATION_BUDGET_PER_TURN) {
              return [
                {
                  ok: false,
                  remaining: 0,
                  reason: `Delegation budget exhausted (${RESEARCH_DELEGATION_BUDGET_PER_TURN} per research run). Synthesize with what you have.`,
                },
                byThread,
              ] as const;
            }
            if (visits >= RESEARCH_STEP_VISIT_LIMIT) {
              return [
                {
                  ok: false,
                  remaining: RESEARCH_DELEGATION_BUDGET_PER_TURN - total,
                  reason: `Step "${step}" already delegated to ${target} ${RESEARCH_STEP_VISIT_LIMIT} times. This loop is cut; move the pipeline forward.`,
                },
                byThread,
              ] as const;
            }

            perStepTarget.set(stepKey, visits + 1);
            const next = new Map(byThread);
            next.set(threadId, { lastChargeMs: nowMs, total: total + 1, perStepTarget });
            return [
              { ok: true, remaining: RESEARCH_DELEGATION_BUDGET_PER_TURN - total - 1 },
              next,
            ] as const;
          },
        ),
    };
  }),
);
