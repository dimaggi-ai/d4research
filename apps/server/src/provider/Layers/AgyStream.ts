import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const AgyInitEvent = Schema.Struct({
  event: Schema.Literal("init"),
  conversation_id: Schema.String,
});

const AgyStepUpdateEvent = Schema.Struct({
  event: Schema.Literal("step_update"),
  step_update: Schema.Struct({
    conversation_id: Schema.String,
    step_index: Schema.Number,
    state: Schema.String,
    step_type: Schema.String,
    text_delta: Schema.optional(Schema.String),
  }),
});

const AgyResultEvent = Schema.Struct({
  event: Schema.Literal("result"),
  result: Schema.Struct({
    conversation_id: Schema.String,
    status: Schema.String,
    response: Schema.optional(Schema.String),
  }),
});

export const AgyStreamEvent = Schema.Union([AgyInitEvent, AgyStepUpdateEvent, AgyResultEvent]);
export type AgyStreamEvent = typeof AgyStreamEvent.Type;

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(AgyStreamEvent));

export function decodeAgyStreamLine(line: string): AgyStreamEvent | undefined {
  return Option.getOrUndefined(decodeLine(line));
}
