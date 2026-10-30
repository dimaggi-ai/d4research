import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

type MigrationEntry<E, R> = readonly [
  id: number,
  name: string,
  migration: Effect.Effect<unknown, E, R>,
];

// d4research shipped these ids before upstream reused them; they stay valid as recorded.
const D4_HISTORICAL_SLOTS = new Map<number, string>([
  [37, "ProjectionThreadTurnUsage"],
  [38, "ProjectionThreadResumeSchedule"],
  [45, "ProjectionQueuedMessages"],
  [46, "ProjectionQueuedMessagesScheduledAt"],
]);

// Names the pilshchikov fork recorded for work d4research's ledger splits differently.
// Its 041 ran workspace roots and the auth-session column together.
const FORK_NAME_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  ProjectionProjectWorkspaceRoots: [
    "ProjectionProjectWorkspaceRoots",
    "AuthSessionClientConnection",
  ],
  ProjectionProjectWorkspaceRootsCompat: ["ProjectionProjectWorkspaceRoots"],
  AuthSessionClientConnectionCompat: ["AuthSessionClientConnection"],
  ForkWorkspaceCompatibility: ["ProjectionProjectWorkspaceRoots", "AuthSessionClientConnection"],
  OrchestrationV2RedundantIndexes: ["RemoveRedundantProjectionIndexes"],
};

/**
 * Databases written by upstream T3 Code or the pilshchikov fork record the same
 * migrations under other ids. The migrator only compares ids, so it would skip
 * or repeat work. Translate such a ledger by migration name into this build's
 * ids, run the migrations that history lacks below its newest translated id,
 * and rewrite the ledger, all in one transaction. A ledger with a name this
 * build does not know is rejected before any schema change.
 */
export const reconcileForkMigrationHistory = Effect.fn("reconcileForkMigrationHistory")(function* <
  E,
  R,
>(entries: ReadonlyArray<MigrationEntry<E, R>>) {
  const sql = yield* SqlClient.SqlClient;
  const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  const canonicalNames = new Map(entries.map(([id, name]) => [id, name]));
  const newestKnownId = Math.max(0, ...canonicalNames.keys());
  const knownNames = new Set(canonicalNames.values());
  const matchesThisLedger = recorded.every((row) => {
    const id = Number(row.migration_id);
    // A newer d4research build may have recorded later migrations; this build still starts.
    if (id > newestKnownId && !knownNames.has(row.name)) return true;
    return canonicalNames.get(id) === row.name || D4_HISTORICAL_SLOTS.get(id) === row.name;
  });
  if (matchesThisLedger) return [];

  const byName = new Map(entries.map((entry) => [entry[1], entry]));
  const applied = new Set<string>();
  for (const row of recorded) {
    for (const name of FORK_NAME_ALIASES[row.name] ?? [row.name]) {
      if (!byName.has(name)) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: `Migration slot ${row.migration_id} is recorded as ${row.name}, ${
            canonicalNames.has(Number(row.migration_id))
              ? `but this build expects ${canonicalNames.get(Number(row.migration_id))}`
              : "which this build cannot upgrade"
          }. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
        });
      }
      applied.add(name);
    }
  }

  const newestApplied = Math.max(0, ...[...applied].map((name) => byName.get(name)![0]));
  const missing = entries.filter(([id, name]) => id < newestApplied && !applied.has(name));
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const [, , migration] of missing) yield* migration;
      yield* sql`DELETE FROM effect_sql_migrations`;
      for (const [id, name] of entries) {
        if (applied.has(name) || id < newestApplied) {
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
        }
      }
      yield* Effect.log("Translated a foreign migration history into this build's ledger").pipe(
        Effect.annotateLogs({
          recorded: recorded.map((row) => `${row.migration_id}_${row.name}`),
          executed: missing.map(([id, name]) => `${id}_${name}`),
        }),
      );
      return missing.map(([id, name]) => [id, name] as const);
    }),
  );
});
