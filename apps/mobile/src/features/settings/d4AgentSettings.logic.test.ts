import { describe, expect, it } from "vite-plus/test";
import { formatQuietHour, parseQuietHour } from "./d4AgentSettings.logic";
describe("d4 Agent quiet hours", () => {
  it.each([
    ["00:00", 0],
    ["08:00", 480],
    ["22:00", 1320],
    ["23:59", 1439],
  ] as const)("round-trips %s without a timezone conversion", (text, minute) => {
    expect(parseQuietHour(text)).toBe(minute);
    expect(formatQuietHour(minute)).toBe(text);
  });
  it.each(["24:00", "23:60", "-1:00", "8:00", "08", "", "12:30:00"])(
    "rejects invalid time %s",
    (value) => expect(parseQuietHour(value)).toBeNull(),
  );
});
