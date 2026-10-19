import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";

export class RelayClientTracer extends Context.Reference(
  "@d4research/shared/relayTracing/RelayClientTracer",
  {
    defaultValue: () => Option.none<Tracer.Tracer>(),
  },
) {}

class LocalTracer extends Context.Reference("@d4research/shared/relayTracing/LocalTracer", {
  defaultValue: () => Option.none<Tracer.Tracer>(),
}) {}

/**
 * Exports every span `effect` creates through the product tracer. Use it only
 * around T3 Connect work; wrap local work inside it with
 * {@link withLocalTracing} so it stays off the product tracer.
 */
export const withRelayClientTracing = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  RelayClientTracer.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => effect,
        onSome: (tracer) =>
          Tracer.Tracer.pipe(
            Effect.flatMap((local) =>
              effect.pipe(
                Effect.provideService(Tracer.Tracer, tracer),
                Effect.provideService(LocalTracer, Option.some(local)),
              ),
            ),
          ),
      }),
    ),
  );

/**
 * Its spans stay in the local trace and are never exported, so a relay span can
 * time the work without shipping what the user's machine did to answer it.
 */
export const withLocalTracing = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  LocalTracer.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => effect,
        onSome: (local) => effect.pipe(Effect.provideService(Tracer.Tracer, local)),
      }),
    ),
  );
