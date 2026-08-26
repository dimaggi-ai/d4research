import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface ScheduledQueueReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly runDue: Effect.Effect<void>;
}

export class ScheduledQueueReactor extends Context.Service<
  ScheduledQueueReactor,
  ScheduledQueueReactorShape
>()("d4research/orchestration/Services/ScheduledQueueReactor") {}
