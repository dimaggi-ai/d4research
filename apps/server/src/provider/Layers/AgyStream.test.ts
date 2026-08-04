import { describe, expect, it } from "@effect/vitest";

import { decodeAgyStreamLine } from "./AgyStream.ts";

describe("decodeAgyStreamLine", () => {
  it("decodes assistant text deltas", () => {
    expect(
      decodeAgyStreamLine(
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: "conversation-1",
            step_index: 2,
            state: "ACTIVE",
            step_type: "agent_response",
            text_delta: "hello",
          },
        }),
      ),
    ).toMatchObject({
      event: "step_update",
      step_update: { step_type: "agent_response", text_delta: "hello" },
    });
  });

  it("rejects non-protocol output", () => {
    expect(decodeAgyStreamLine("not-json")).toBeUndefined();
  });
});
