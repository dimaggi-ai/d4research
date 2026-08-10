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
 * State is keyed by orchestrator turn, so a fresh dev/research run in the same
 * durable thread always receives a fresh budget without waiting for a timer.
 */
export interface ResearchBudgetCharge {
  readonly ok: boolean;
  readonly remaining: number;
  readonly reason?: string;
}

interface RunBudgetState {
  readonly total: number;
  readonly perStepTarget: ReadonlyMap<string, number>;
  readonly lastTouchedAt: number;
}

/** Hard bound for abandoned/completed run accounting retained in one server process. */
export const RESEARCH_RETAINED_RUN_LIMIT = 1_024;
/**
 * A delegate may legitimately run for 30 minutes. Only accounting untouched
 * for four times that deadline is safe to classify as abandoned. A full map
 * with no such entry rejects new runs; it never resets a possibly active run.
 */
export const RESEARCH_RUN_IDLE_RETENTION_MILLIS = 2 * 60 * 60 * 1_000;

export class ResearchDelegationBudget extends Context.Service<
  ResearchDelegationBudget,
  {
    readonly charge: (input: {
      readonly runId: string;
      readonly step: string;
      readonly target: string;
    }) => Effect.Effect<ResearchBudgetCharge>;
  }
>()("t3/mcp/toolkits/research/budget/ResearchDelegationBudget") {}

export const ResearchDelegationBudgetLive = Layer.effect(
  ResearchDelegationBudget,
  Effect.gen(function* () {
    const state = yield* Ref.make(new Map<string, RunBudgetState>());
    return {
      charge: ({ runId, step, target }) =>
        Effect.gen(function* () {
          const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
          return yield* Ref.modify(
            state,
            (byRun): readonly [ResearchBudgetCharge, Map<string, RunBudgetState>] => {
              const previous = byRun.get(runId);
              const total = previous?.total ?? 0;
              const perStepTarget = new Map(previous?.perStepTarget ?? []);
              const stepKey = `${step}→${target}`;
              const visits = perStepTarget.get(stepKey) ?? 0;

              const touched = () => {
                if (previous === undefined) return byRun;
                const next = new Map(byRun);
                next.set(runId, { ...previous, lastTouchedAt: now });
                return next;
              };

              if (total >= RESEARCH_DELEGATION_BUDGET_PER_TURN) {
                return [
                  {
                    ok: false,
                    remaining: 0,
                    reason: `Delegation budget exhausted (${RESEARCH_DELEGATION_BUDGET_PER_TURN} per research run). Synthesize with what you have.`,
                  },
                  touched(),
                ] as const;
              }
              if (visits >= RESEARCH_STEP_VISIT_LIMIT) {
                return [
                  {
                    ok: false,
                    remaining: RESEARCH_DELEGATION_BUDGET_PER_TURN - total,
                    reason: `Step "${step}" already delegated to ${target} ${RESEARCH_STEP_VISIT_LIMIT} times. This loop is cut; move the pipeline forward.`,
                  },
                  touched(),
                ] as const;
              }

              perStepTarget.set(stepKey, visits + 1);
              const next = new Map(byRun);
              if (!next.has(runId)) {
                for (const [retainedRunId, retained] of next) {
                  if (now - retained.lastTouchedAt >= RESEARCH_RUN_IDLE_RETENTION_MILLIS) {
                    next.delete(retainedRunId);
                  }
                }
                if (next.size >= RESEARCH_RETAINED_RUN_LIMIT) {
                  return [
                    {
                      ok: false,
                      remaining: RESEARCH_DELEGATION_BUDGET_PER_TURN,
                      reason:
                        "Research delegation capacity is temporarily full. Wait for an active run to finish rather than retrying recursively.",
                    },
                    byRun,
                  ] as const;
                }
              }
              next.set(runId, { total: total + 1, perStepTarget, lastTouchedAt: now });
              return [
                { ok: true, remaining: RESEARCH_DELEGATION_BUDGET_PER_TURN - total - 1 },
                next,
              ] as const;
            },
          );
        }),
    };
  }),
);
