// Warn on completed research-orchestrator runs that claim pipeline progress
// without a recorded research_delegate call.
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ResearchIntegrityReactorShape {
  /**
   * Start the reactor. Must run in a scope so the worker fiber is finalized on
   * shutdown. Consumes committed V2 run-completion events.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /** Resolves when the internal queue is empty and idle. Test-only. */
  readonly drain: Effect.Effect<void>;
}

export class ResearchIntegrityReactor extends Context.Service<
  ResearchIntegrityReactor,
  ResearchIntegrityReactorShape
>()("d4research/orchestration-v2/Services/ResearchIntegrityReactor") {}
