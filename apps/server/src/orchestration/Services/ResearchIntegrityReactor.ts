/**
 * ResearchIntegrityReactor - honesty guard for research-orchestrator threads.
 *
 * Reacts to completed turns and, when a research-orchestrator thread advanced
 * the pipeline in prose without ever calling `research_delegate`, appends a
 * visible warning so a faked pipeline cannot pass as real work.
 *
 * @module ResearchIntegrityReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ResearchIntegrityReactorShape {
  /**
   * Start the reactor. Must run in a scope so the worker fiber is finalized on
   * shutdown. Consumes orchestration-domain turn-completion events.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /** Resolves when the internal queue is empty and idle. Test-only. */
  readonly drain: Effect.Effect<void>;
}

export class ResearchIntegrityReactor extends Context.Service<
  ResearchIntegrityReactor,
  ResearchIntegrityReactorShape
>()("d4research/orchestration/Services/ResearchIntegrityReactor") {}
