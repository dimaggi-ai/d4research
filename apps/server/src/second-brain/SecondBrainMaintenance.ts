import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecondBrainService from "./SecondBrainService.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* SecondBrainService.SecondBrainService;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register(
      "second-brain",
      service.reconcile().pipe(
        Effect.asVoid,
        Effect.catchTags({
          SecondBrainError: (error) =>
            error.code === "disabled" ? Effect.void : Effect.fail(error),
        }),
      ),
    );
  }),
);
