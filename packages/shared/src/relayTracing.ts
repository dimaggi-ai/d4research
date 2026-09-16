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

export const withRelayClientTracing = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  RelayClientTracer.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => effect,
        onSome: (tracer) => effect.pipe(Effect.provideService(Tracer.Tracer, tracer)),
      }),
    ),
  );
