/** Cache snapshots per provider instance so accounts cannot overwrite each other; only unambiguous Codex histories seed missing live data. */
import {
  ACCOUNT_LIMITS_CONTRACT_VERSION,
  AccountLimitsSnapshot,
  type AccountLimitsSummary,
  CodexSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
  type UsageProviderKind,
} from "@d4research/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "@d4research/shared/atomicWrite";
import { ServerConfig } from "../config.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as HostProcess from "@d4research/shared/HostProcess";

import { expandHomePath } from "@d4research/provider-core/server/pathExpansion";
import * as ServerSettings from "../serverSettings.ts";
import {
  accountWindowsFromProviderUpdate,
  claudeUsageSnapshotFromUnknown,
  claudeWindowsFromRateLimitEvent,
  codexSnapshotFromUnknown,
  isPrimaryCodexLimit,
  sortWindows,
} from "./accountLimitsNormalize.ts";
import { readLatestCodexRateLimits } from "./accountLimitsTranscripts.ts";

/** Failed or empty transcript scans are not retried more often than this. */
const CODEX_SEED_MIN_INTERVAL_MS = 60_000;

/** On-disk shape of the snapshot cache: the contract array, JSON-encoded. */
const LimitsCacheFile = Schema.Array(AccountLimitsSnapshot);
const decodeLimitsCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LimitsCacheFile as unknown as Schema.Codec<typeof LimitsCacheFile.Type>),
);
const encodeLimitsCache = Schema.encodeEffect(
  Schema.fromJsonString(LimitsCacheFile as unknown as Schema.Codec<typeof LimitsCacheFile.Type>),
);
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

export interface AccountLimitsIngestInput {
  /** Driver kind off the runtime event (`claudeAgent`, `codex`, ...). */
  readonly provider: string;
  /** The event's `payload.rateLimits`, in whatever shape the adapter emitted. */
  readonly payload: unknown;
  readonly createdAt: string;
  /** Legacy events without an instance id belong to the driver default, matching their original routing. */
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}

export class AccountLimitsService extends Context.Service<
  AccountLimitsService,
  {
    readonly readSummary: () => Effect.Effect<AccountLimitsSummary>;
    readonly ingest: (input: AccountLimitsIngestInput) => Effect.Effect<void>;
  }
>()("t3/usage/AccountLimitsService") {}

/** Empty cache, for suites that only need the RPC surface to resolve. */

function providerFromDriver(driver: string): UsageProviderKind | null {
  if (driver === "claudeAgent") return "claude";
  if (driver === "codex") return "codex";
  return null;
}

/** Legacy emitters used the driver kind as the instance id; retain that identity for older cache rows. */
function defaultInstanceIdForProvider(provider: UsageProviderKind): ProviderInstanceId {
  return defaultInstanceIdForDriver(
    ProviderDriverKind.make(provider === "claude" ? "claudeAgent" : "codex"),
  );
}

/**
 * Map key for one (provider, instance) slot. Structured, not interpolated:
 * no spelling of an instance id can collide with another slot's key.
 */
function slotKey(provider: UsageProviderKind, instanceId: ProviderInstanceId): string {
  return JSON.stringify([provider, instanceId]);
}

/** One codex instance's resolved transcript location. */
export interface CodexSeedTarget {
  readonly instanceId: ProviderInstanceId;
  readonly sessionsDir: string;
  /** Disabled instances still own their transcript directories and must count toward attribution ambiguity. */
  readonly enabled: boolean;
}

/** Shared Codex session directories cannot identify an account; seed only enabled instances with exclusive ownership. */
export function planCodexTranscriptSeeds(
  targets: readonly CodexSeedTarget[],
): readonly CodexSeedTarget[] {
  const byDir = new Map<string, readonly CodexSeedTarget[]>();
  for (const target of targets) {
    byDir.set(target.sessionsDir, [...(byDir.get(target.sessionsDir) ?? []), target]);
  }
  return [...byDir.values()].flatMap((owners) => (owners.length === 1 ? owners : []));
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;

  const snapshots = new Map<string, AccountLimitsSnapshot>();
  /** The first live event disambiguates a migrated single-slot row; evict it when another account proves ownership ambiguous. */
  const hostEnvironment = yield* HostProcess.Environment;
  const migratedSlots = new Set<string>();
  const cachePath = path.join(config.stateDir, "account-limits.json");
  let lastCodexSeedAttemptAtMs = 0;

  // Restarts must not lose the Claude snapshot (stream-only, no disk source),
  // so the cache is persisted. Same Effect.cached trick as the usage scan
  // cache: concurrent first readers await one load.
  const ensureLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const stored = yield* fileSystem.readFileString(cachePath).pipe(
        Effect.flatMap((raw) => decodeLimitsCache(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (stored === null) return;
      for (const snapshot of stored) {
        // Rows written before instance attribution migrate to the default
        // instance rather than being discarded: Claude has no disk source,
        // so a wiped cache is an empty Limits strip until a session runs.
        const instanceId = snapshot.instanceId ?? defaultInstanceIdForProvider(snapshot.provider);
        const key = slotKey(snapshot.provider, instanceId);
        if (!snapshots.has(key)) {
          snapshots.set(key, { ...snapshot, instanceId });
          if (snapshot.instanceId === undefined) migratedSlots.add(key);
        }
      }
    }),
  );

  /** Serialize event ingestion, transcript seeding and eviction so ordering checks and persistence stay atomic; reads remain lock-free. */
  const stateLock = yield* Semaphore.make(1);

  // A cache we cannot write is a colder next start, not a failure. Only
  // called while holding `stateLock`, which is what serializes writes; the
  // temp-file + rename keeps a crashed write from tearing the file.
  const persist = Effect.fn("AccountLimitsService.persist")(function* () {
    // A still-unconfirmed migrated row is written back in its v1 shape (no
    // instanceId): the marker lives only in memory, and persisting the
    // synthesized id would make the row look settled after any restart -
    // permanently exempt from the other-instance eviction in `store`.
    const rows = [...snapshots.entries()].map(([key, snapshot]) => {
      if (!migratedSlots.has(key)) return snapshot;
      const { instanceId: _instanceId, ...rest } = snapshot;
      return rest;
    });
    yield* encodeLimitsCache(rows).pipe(
      Effect.flatMap((serialized) =>
        writeFileStringAtomically({ filePath: cachePath, contents: serialized }),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.ignoreCause,
    );
  });

  const store = Effect.fn("AccountLimitsService.store")(function* (
    snapshot: AccountLimitsSnapshot & { readonly instanceId: ProviderInstanceId },
  ) {
    const key = slotKey(snapshot.provider, snapshot.instanceId);
    snapshots.set(key, snapshot);
    // Live data on a slot settles what that slot is; live data on any OTHER
    // instance of the provider evicts a still-unconfirmed migrated row (see
    // `migratedSlots`).
    migratedSlots.delete(key);
    const defaultKey = slotKey(snapshot.provider, defaultInstanceIdForProvider(snapshot.provider));
    if (key !== defaultKey && migratedSlots.has(defaultKey)) {
      snapshots.delete(defaultKey);
      migratedSlots.delete(defaultKey);
    }
    yield* persist();
  });

  const ingestClaude = Effect.fn("AccountLimitsService.ingestClaude")(function* (
    payload: unknown,
    createdAt: string,
    instanceId: ProviderInstanceId,
  ) {
    const previous = snapshots.get(slotKey("claude", instanceId));
    const full = claudeUsageSnapshotFromUnknown(payload);
    if (full !== null) {
      // Rate limits do not apply to this account (API key / Bedrock / Vertex):
      // nothing to show, and nothing worth clearing a previous snapshot over.
      if (full.windows.length === 0) return;
      yield* store({
        provider: "claude",
        instanceId,
        plan: full.plan ?? previous?.plan ?? null,
        windows: full.windows,
        asOf: createdAt,
        source: "live",
      });
      return;
    }
    // Current streamed events can carry every window; older ones name only
    // the binding window. Patch every reported id into this instance's set.
    const updates = claudeWindowsFromRateLimitEvent(payload);
    const normalizedUpdates =
      updates.length > 0 ? updates : accountWindowsFromProviderUpdate(payload);
    if (normalizedUpdates.length === 0) return;
    const updatedIds = new Set(normalizedUpdates.map((window) => window.id));
    const windows = sortWindows([
      ...(previous?.windows ?? []).filter((existing) => !updatedIds.has(existing.id)),
      ...normalizedUpdates,
    ]);
    yield* store({
      provider: "claude",
      instanceId,
      plan: previous?.plan ?? null,
      windows,
      asOf: createdAt,
      source: "live",
    });
  });

  const ingestCodex = Effect.fn("AccountLimitsService.ingestCodex")(function* (
    payload: unknown,
    createdAt: string,
    instanceId: ProviderInstanceId,
  ) {
    const snapshot = codexSnapshotFromUnknown(payload);
    const canonicalWindows = accountWindowsFromProviderUpdate(payload);
    if (snapshot === null && canonicalWindows.length === 0) return;
    // Per-model side meters (Spark) are not surfaced.
    if (snapshot !== null && !isPrimaryCodexLimit(snapshot.limitId)) return;
    const windows = snapshot?.windows.length ? snapshot.windows : canonicalWindows;
    if (windows.length === 0) return;
    const previous = snapshots.get(slotKey("codex", instanceId));
    yield* store({
      provider: "codex",
      instanceId,
      plan: snapshot?.plan ?? previous?.plan ?? null,
      windows,
      asOf: createdAt,
      source: "live",
    });
  });

  const ingest = Effect.fn("AccountLimitsService.ingest")(function* (
    input: AccountLimitsIngestInput,
  ) {
    const provider = providerFromDriver(input.provider);
    if (provider === null) return;
    const instanceId = input.providerInstanceId ?? defaultInstanceIdForProvider(provider);
    yield* ensureLoaded;
    yield* stateLock.withPermits(1)(
      Effect.gen(function* () {
        // Guard against out-of-order delivery: an event older than what is
        // already stored must not roll the snapshot backwards. Per slot -
        // one instance's traffic must not suppress another's.
        const existing = snapshots.get(slotKey(provider, instanceId));
        if (existing !== undefined && input.createdAt < existing.asOf) return;
        if (provider === "claude") {
          yield* ingestClaude(input.payload, input.createdAt, instanceId);
        } else {
          yield* ingestCodex(input.payload, input.createdAt, instanceId);
        }
      }),
    );
  });

  /** Recover newer external Codex measurements only from exclusively owned session directories, including the legacy default instance. */
  const maybeSeedCodexFromTranscripts = Effect.fn("AccountLimitsService.seedCodex")(function* (
    nowMs: number,
    configMap: ProviderInstanceConfigMap | null,
  ) {
    if (configMap === null) return;
    if (nowMs - lastCodexSeedAttemptAtMs < CODEX_SEED_MIN_INTERVAL_MS) return;
    lastCodexSeedAttemptAtMs = nowMs;

    const targets: CodexSeedTarget[] = [];
    for (const [rawInstanceId, entry] of Object.entries(configMap)) {
      if (entry.driver !== "codex") continue;
      const codexSettings = yield* decodeCodexSettings(entry.config ?? {}).pipe(
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (codexSettings === null) continue;
      // Where the spawned CLI actually writes: an explicit homePath wins,
      // else the CODEX_HOME its child env would carry (instance override,
      // then ambient) - resolveCodexHomeLayout alone answers ~/.codex even
      // when the CLI it describes is writing somewhere else.
      let sessionsParent: string;
      const envOverride = entry.environment
        ?.find((variable) => variable.name === "CODEX_HOME")
        ?.value.trim();
      // A shadow overlay pins the layout: spawn overrides CODEX_HOME with
      // the overlay path, so an instance env value never reaches the CLI.
      const envHome =
        codexSettings.homePath.trim() === "" && codexSettings.shadowHomePath.trim() === ""
          ? envOverride || hostEnvironment["CODEX_HOME"]?.trim() || ""
          : "";
      if (envHome !== "") {
        sessionsParent = expandHomePath(envHome, yield* HostProcess.HomeDirectory);
      } else {
        const layout = yield* resolveCodexHomeLayout(codexSettings).pipe(
          Effect.provideService(Path.Path, path),
        );
        sessionsParent = layout.sharedHomePath;
      }
      const sessionsDir = path.join(sessionsParent, "sessions");
      // Compare filesystem identity, not spellings: a symlinked home and its
      // target are one directory, and treating them as two would hand the
      // same account-ambiguous transcripts to both.
      const canonical = yield* fileSystem
        .realPath(sessionsDir)
        .pipe(Effect.catchCause(() => Effect.succeed(sessionsDir)));
      targets.push({
        instanceId: ProviderInstanceId.make(rawInstanceId),
        sessionsDir: canonical,
        enabled: entry.enabled !== false,
      });
    }

    for (const target of planCodexTranscriptSeeds(targets)) {
      if (!target.enabled) continue;
      const found = yield* Effect.promise(() =>
        readLatestCodexRateLimits(target.sessionsDir, nowMs),
      );
      if (found === null) continue;
      const asOf = DateTime.formatIso(DateTime.makeUnsafe(found.asOfMs));
      // The slow transcript reads happened outside the lock; only the
      // guard-and-store is serialized against live ingests.
      yield* stateLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = snapshots.get(slotKey("codex", target.instanceId));
          // ISO-8601 strings order lexicographically.
          if (existing !== undefined && existing.asOf >= asOf) return;
          yield* store({
            provider: "codex",
            instanceId: target.instanceId,
            plan: found.snapshot.plan ?? existing?.plan ?? null,
            windows: found.snapshot.windows,
            asOf,
            source: "transcript",
          });
        }),
      );
    }
  });

  const readSummary = Effect.fn("AccountLimitsService.readSummary")(function* () {
    yield* ensureLoaded;
    const nowMs = yield* Clock.currentTimeMillis;
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchCause(() => Effect.succeed(null)),
    );
    const configMap = settings === null ? null : deriveProviderInstanceConfigMap(settings);
    yield* maybeSeedCodexFromTranscripts(nowMs, configMap).pipe(Effect.ignoreCause);
    // Evict deleted instances, but retain disabled account caches for re-enablement without showing ghost rows.
    if (configMap !== null) {
      yield* stateLock.withPermits(1)(
        Effect.gen(function* () {
          let evicted = false;
          for (const [key, snapshot] of snapshots) {
            const instanceId =
              snapshot.instanceId ?? defaultInstanceIdForProvider(snapshot.provider);
            const entry = configMap[instanceId];
            // Gone entirely, or reconfigured to a different driver: either
            // way the row's data belongs to an account this id no longer
            // names, and a stale row would be captioned with the NEW
            // driver's display name.
            if (entry === undefined || providerFromDriver(entry.driver) !== snapshot.provider) {
              snapshots.delete(key);
              migratedSlots.delete(key);
              evicted = true;
            }
          }
          if (evicted) yield* persist();
        }),
      );
    }
    const visible = [...snapshots.values()].filter((snapshot) => {
      if (configMap === null) return true;
      const instanceId = snapshot.instanceId ?? defaultInstanceIdForProvider(snapshot.provider);
      return configMap[instanceId]?.enabled !== false;
    });
    return {
      contractVersion: ACCOUNT_LIMITS_CONTRACT_VERSION,
      readAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      // Codepoint order, not localeCompare: instance ids are user-authored
      // slugs and the summary's order must not change with the host locale.
      snapshots: visible.sort((a, b) => {
        const left = `${a.provider} ${a.instanceId ?? ""}`;
        const right = `${b.provider} ${b.instanceId ?? ""}`;
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    } satisfies AccountLimitsSummary;
  });

  return { readSummary, ingest } as const;
});

export const layer = Layer.effect(AccountLimitsService, make);
