import {
  UsageLimitHistory as History,
  type UsageLimitHistoryInput,
  type UsageLimitHistoryPoint,
  UsageReadError,
} from "@d4research/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/sql";

const SAMPLE_MS = 30_000;
const RETENTION_MS = 90 * 24 * 60 * 60_000;

export class UsageLimitHistory extends Context.Service<
  UsageLimitHistory,
  {
    readonly record: (
      points: readonly UsageLimitHistoryPoint[],
    ) => Effect.Effect<void, UsageReadError>;
    readonly read: (input: UsageLimitHistoryInput) => Effect.Effect<History, UsageReadError>;
  }
>()("t3/usage/UsageLimitHistory") {}

export const layer = Layer.effect(
  UsageLimitHistory,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storageError = (cause: unknown) =>
      new UsageReadError({
        reason: "scanFailed",
        detail: "Could not access usage limit history.",
        cause,
      });
    const record = Effect.fn("UsageLimitHistory.record")(function* (
      points: readonly UsageLimitHistoryPoint[],
    ) {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const point of points) {
            const time = Date.parse(point.measuredAt);
            if (
              !Number.isFinite(time) ||
              time < now - RETENTION_MS ||
              time > now + 60_000 ||
              !Number.isFinite(point.remainingPercent) ||
              point.remainingPercent < 0 ||
              point.remainingPercent > 100
            )
              continue;
            const bucket = Math.floor(time / SAMPLE_MS) * SAMPLE_MS;
            yield* sql`INSERT INTO usage_limit_history
          (account_id, label, color, window_id, window_label, bucket, measured_at, remaining_percent, resets_at)
          VALUES (${point.accountId}, ${point.label}, ${point.color}, ${point.windowId},
            ${point.windowLabel}, ${bucket}, ${point.measuredAt}, ${point.remainingPercent}, ${point.resetsAt})
          ON CONFLICT(account_id, window_id, bucket) DO UPDATE SET
            label=excluded.label, color=excluded.color, window_label=excluded.window_label,
            measured_at=excluded.measured_at, remaining_percent=excluded.remaining_percent, resets_at=excluded.resets_at
          WHERE excluded.measured_at > usage_limit_history.measured_at`;
          }
          yield* sql`DELETE FROM usage_limit_history WHERE bucket < ${now - RETENTION_MS}`;
        }),
      );
    }, Effect.mapError(storageError));

    const read = Effect.fn("UsageLimitHistory.read")(function* ({ days }: UsageLimitHistoryInput) {
      const now = yield* DateTime.now;
      const sinceMs = DateTime.toEpochMillis(now) - days * 24 * 60 * 60_000;
      const resolutionMinutes = days === 1 ? 0.5 : days === 7 ? 30 : days === 30 ? 120 : 360;
      const resolutionMs = resolutionMinutes * 60_000;
      const rows =
        yield* sql`SELECT account_id AS "accountId", label, color, window_id AS "windowId",
      window_label AS "windowLabel", measured_at AS "measuredAt", remaining_percent AS "remainingPercent",
      resets_at AS "resetsAt" FROM (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY account_id, window_id, CAST(bucket / ${resolutionMs} AS INTEGER)
          ORDER BY measured_at DESC
        ) AS position FROM usage_limit_history WHERE bucket >= ${sinceMs}
      ) WHERE position = 1 ORDER BY measured_at DESC LIMIT 20001`;
      return yield* Schema.decodeUnknownEffect(History)({
        readAt: DateTime.formatIso(now),
        since: DateTime.formatIso(DateTime.makeUnsafe(sinceMs)),
        resolutionMinutes,
        truncated: rows.length > 20000,
        points: rows.slice(0, 20000).reverse(),
      });
    }, Effect.mapError(storageError));
    return UsageLimitHistory.of({ record, read });
  }),
);
