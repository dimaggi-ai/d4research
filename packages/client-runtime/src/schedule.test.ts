// @effect-diagnostics globalDate:off -- fixtures exercise client-local schedule parsing.
import { describe, expect, it } from "vite-plus/test";
import { parseScheduledMessage } from "./schedule.js";

const NOW = new Date("2026-08-26T12:00:00.000Z");

describe("parseScheduledMessage", () => {
  it.each([
    ["!schedule:30s check", "2026-08-26T12:00:30.000Z"],
    ["#schedule:16m check", "2026-08-26T12:16:00.000Z"],
    ["!schedule:2h check", "2026-08-26T14:00:00.000Z"],
    ["!schedule:1d check", "2026-08-27T12:00:00.000Z"],
  ])("parses %s", (input, scheduledAt) => {
    expect(parseScheduledMessage(input, NOW)).toEqual({
      kind: "scheduled",
      text: "check",
      scheduledAt,
    });
  });

  it("rejects ambiguous invalid clock syntax", () => {
    expect(parseScheduledMessage("!schedule:16pm check", NOW)).toMatchObject({ kind: "invalid" });
  });

  it("ignores normal messages", () => {
    expect(parseScheduledMessage("please schedule this", NOW)).toEqual({ kind: "none" });
  });
});
