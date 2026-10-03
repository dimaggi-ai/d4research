import type { OrchestrationV2ProjectedTurnItem } from "@d4research/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveTimelineEntriesFromVisibleTurnItems } from "./session-logic";
import { makeStreamingTimelineFixture } from "./test-fixtures";

describe("V2 command output projection", () => {
  it.each(["hello", "printf hello", "hello\n<exited with exit code 0>", ""])(
    "retains normalized provider output %j separately from the command",
    (output) => {
      const fixture = makeStreamingTimelineFixture();
      const base = fixture.visibleTurnItems.find((row) => row.item.type === "dynamic_tool")!;
      if (base.item.type !== "dynamic_tool") throw new Error("Missing tool fixture");
      const row: OrchestrationV2ProjectedTurnItem = {
        ...base,
        item: {
          ...base.item,
          type: "command_execution",
          input: "printf hello",
          output,
          exitCode: 0,
        },
      };
      const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: [row],
        optimisticMessages: [],
      });
      expect(entry).toMatchObject({
        kind: "work",
        entry: {
          command: "printf hello",
          rawCommand: "printf hello",
          structuredPayload: {
            type: "command_execution",
            input: "printf hello",
            output,
            exitCode: 0,
          },
        },
      });
    },
  );
});
