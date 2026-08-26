// @effect-diagnostics globalDate:off -- schedule clock syntax intentionally follows the client's local calendar and time zone.
export type ScheduleParseResult =
  | { readonly kind: "none" }
  | { readonly kind: "scheduled"; readonly text: string; readonly scheduledAt: string }
  | { readonly kind: "invalid"; readonly error: string };

const PREFIX = /^\s*[!#]schedule\s*:\s*(\S+)(?:\s+([\s\S]*))?$/i;
const RELATIVE = /^(\d+)(s|m|h|d)$/i;
const CLOCK_24 = /^(\d{1,2}):(\d{2})$/;
const CLOCK_12 = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/i;

export function parseScheduledMessage(input: string, now = new Date()): ScheduleParseResult {
  if (!/^\s*[!#]schedule\b/i.test(input)) return { kind: "none" };
  const match = PREFIX.exec(input);
  if (!match) {
    return { kind: "invalid", error: "Use !schedule:<time> followed by a message." };
  }
  const spec = match[1] ?? "";
  const text = (match[2] ?? "").trim();
  if (!text) return { kind: "invalid", error: "Add a message after the schedule time." };

  const relative = RELATIVE.exec(spec);
  if (relative) {
    const amount = Number(relative[1]);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return { kind: "invalid", error: "Schedule duration must be greater than zero." };
    }
    const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
    return {
      kind: "scheduled",
      text,
      scheduledAt: new Date(
        now.getTime() + amount * unitMs[relative[2]!.toLowerCase() as keyof typeof unitMs],
      ).toISOString(),
    };
  }

  let hours: number | null = null;
  let minutes = 0;
  const twelveHour = CLOCK_12.exec(spec);
  if (twelveHour) {
    const hour = Number(twelveHour[1]);
    minutes = Number(twelveHour[2] ?? 0);
    if (hour < 1 || hour > 12 || minutes > 59) {
      return { kind: "invalid", error: `Invalid schedule time “${spec}”.` };
    }
    hours = (hour % 12) + (twelveHour[3]!.toLowerCase() === "pm" ? 12 : 0);
  } else {
    const twentyFourHour = CLOCK_24.exec(spec);
    if (twentyFourHour) {
      hours = Number(twentyFourHour[1]);
      minutes = Number(twentyFourHour[2]);
      if (hours > 23 || minutes > 59) hours = null;
    }
  }
  if (hours === null) {
    return {
      kind: "invalid",
      error: `Invalid schedule time “${spec}”. Try 4pm, 16:00, 30s, 16m, 2h, or 1d.`,
    };
  }
  const scheduled = new Date(now);
  scheduled.setHours(hours, minutes, 0, 0);
  if (scheduled.getTime() <= now.getTime()) scheduled.setDate(scheduled.getDate() + 1);
  return { kind: "scheduled", text, scheduledAt: scheduled.toISOString() };
}
