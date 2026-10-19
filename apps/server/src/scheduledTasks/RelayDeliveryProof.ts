import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

export class RelayDeliveryProof extends Context.Service<
  RelayDeliveryProof,
  {
    readonly verify: (input: {
      readonly headers: Readonly<Record<string, string>>;
      readonly hookId: string;
    }) => Effect.Effect<
      Option.Option<{ readonly deliveryId: string; readonly receivedAt: string }>
    >;
  }
>()("d4research/scheduledTasks/RelayDeliveryProof") {}

// d4research does not link environments to T3 Connect. Forwarded headers
// never establish a trusted delivery identity on this release line.
export const layer = Layer.succeed(
  RelayDeliveryProof,
  RelayDeliveryProof.of({
    verify: () => Effect.succeed(Option.none()),
  }),
);
