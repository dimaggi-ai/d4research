import {
  type D4AgentScopeReviewer,
  type ModelSelection,
  type ServerProvider,
  canStartProviderTurn,
} from "@d4research/contracts";
import type { ScopeReviewGenerationResult } from "@d4research/provider-core/server/textGeneration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

/**
 * The design-reduction reviewers. They are the only models this step may use, and this step is
 * the only Nia path that may use them: ordinary task creation runs on the task model.
 */
export const SCOPE_REVIEWERS = {
  fable: { driver: "claudeAgent", model: "claude-fable-5-2" },
  astra: { driver: "codex", model: "gpt-6-astra" },
} as const satisfies Record<D4AgentScopeReviewer, { driver: string; model: string }>;

export type ScopeReviewFailure = "reviewer-unavailable" | "review-failed";

export class ScopeReviewer extends Context.Service<
  ScopeReviewer,
  {
    readonly review: (input: {
      readonly reviewer: D4AgentScopeReviewer;
      readonly brief: string;
      readonly cwd: string;
      readonly providers: ReadonlyArray<ServerProvider>;
    }) => Effect.Effect<
      { readonly modelSelection: ModelSelection; readonly result: ScopeReviewGenerationResult },
      ScopeReviewFailure
    >;
  }
>()("d4research/d4Agent/ScopeReviewer") {}

/** The first ready provider instance of the reviewer's driver that lists the reviewer's model. */
function scopeReviewerSelection(
  reviewer: D4AgentScopeReviewer,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  const target = SCOPE_REVIEWERS[reviewer];
  const provider = providers.find(
    (entry) =>
      entry.driver === target.driver &&
      canStartProviderTurn(entry) &&
      entry.models.some((model) => model.slug === target.model),
  );
  return provider === undefined ? null : { instanceId: provider.instanceId, model: target.model };
}

export const layer = Layer.effect(
  ScopeReviewer,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    return ScopeReviewer.of({
      review: Effect.fn("ScopeReviewer.review")(function* ({ reviewer, brief, cwd, providers }) {
        const modelSelection = scopeReviewerSelection(reviewer, providers);
        if (modelSelection === null) return yield* Effect.fail("reviewer-unavailable" as const);
        const instance = yield* registry.getInstance(modelSelection.instanceId);
        const generate = instance?.textGeneration.generateScopeReview;
        if (generate === undefined) return yield* Effect.fail("reviewer-unavailable" as const);
        const result = yield* generate({ cwd, brief, modelSelection }).pipe(
          Effect.mapError(() => "review-failed" as const),
        );
        return { modelSelection, result };
      }),
    });
  }),
);
