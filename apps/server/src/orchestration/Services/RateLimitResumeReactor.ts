import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface RateLimitResumeReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly runDue: Effect.Effect<void>;
}

export class RateLimitResumeReactor extends Context.Service<
  RateLimitResumeReactor,
  RateLimitResumeReactorShape
>()("d4research/orchestration/Services/RateLimitResumeReactor") {}
