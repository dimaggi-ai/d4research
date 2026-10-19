import * as Clock from "effect/Clock";
import { ServerSettingsService } from "../serverSettings.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CaptureReactor from "./SecondBrainCaptureReactor.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecondBrainService from "./SecondBrainService.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* SecondBrainService.SecondBrainService;
    const capture = yield* CaptureReactor.SecondBrainCaptureReactor;
    const scheduler = yield* Scheduler.Scheduler;
    const settings = yield* ServerSettingsService;
    let lastRun: number | undefined;
    yield* scheduler.register(
      "second-brain",
      Effect.gen(function* () {
        const config = yield* settings.getSettings;
        const now = yield* Clock.currentTimeMillis;
        if (
          lastRun !== undefined &&
          now - lastRun < config.secondBrain.reconcileIntervalSeconds * 1000
        )
          return;
        yield* service.reconcile();
        yield* capture.retry();
        lastRun = now;
      }).pipe(
        Effect.asVoid,
        Effect.catchTags({
          SecondBrainError: (error) =>
            error.code === "disabled" ? Effect.void : Effect.fail(error),
        }),
      ),
    );
  }),
);
