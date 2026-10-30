/** Share version-advisory cache entries across drivers and maintenance, retaining explicit invalidation after updates. */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

const FOUND_TTL = Duration.hours(1);
const MISSING_TTL = Duration.minutes(1);

interface Entry {
  readonly expiresAt: number;
  readonly version: string | null;
}

export class ProviderLatestVersions extends Context.Service<
  ProviderLatestVersions,
  {
    readonly cached: <E, R>(
      key: string,
      lookup: Effect.Effect<string | null, E, R>,
      options?: { readonly fresh?: boolean },
    ) => Effect.Effect<string | null, E, R>;
    readonly invalidate: (key: string) => Effect.Effect<void>;
  }
>()("@d4research/provider-core/server/ProviderLatestVersions") {}

export const make = Effect.fn("ProviderLatestVersions.make")(function* (
  seed: Iterable<readonly [key: string, version: string | null]> = [],
) {
  const entries = yield* Ref.make(
    new Map<string, Entry>(
      Array.from(seed, ([key, version]) => [key, { version, expiresAt: Number.MAX_SAFE_INTEGER }]),
    ),
  );
  return ProviderLatestVersions.of({
    cached: Effect.fn("ProviderLatestVersions.cached")(function* (key, lookup, options) {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const existing = (yield* Ref.get(entries)).get(key);
      if (!options?.fresh && existing && existing.expiresAt > now) return existing.version;
      // Replacing or invalidating this entry retires any lookup still in flight.
      const pending = { version: null, expiresAt: 0 };
      yield* Ref.update(entries, (current) => new Map(current).set(key, pending));
      const version = yield* lookup;
      const ttl = version === null ? MISSING_TTL : FOUND_TTL;
      yield* Ref.update(entries, (current) =>
        current.get(key) === pending
          ? new Map(current).set(key, { version, expiresAt: now + Duration.toMillis(ttl) })
          : current,
      );
      return version;
    }),
    invalidate: Effect.fn("ProviderLatestVersions.invalidate")(function (key) {
      return Ref.update(entries, (current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    }),
  });
});

// Fork policy: every provider's remote version lookup is opt-in, including
// release-channel lookups that bypass the npm maintenance resolver.
export const layer = Layer.effect(
  ProviderLatestVersions,
  Effect.gen(function* () {
    const enabled = yield* Config.Boolean("T3CODE_ENABLE_PROVIDER_VERSION_CHECKS").pipe(
      Config.withDefault(false),
      Effect.orElseSucceed(() => false),
    );
    const versions = yield* make();
    return enabled
      ? versions
      : ProviderLatestVersions.of({
          cached: Effect.fn("ProviderLatestVersions.cached")(() => Effect.succeed(null)),
          invalidate: versions.invalidate,
        });
  }),
);
