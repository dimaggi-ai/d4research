import { npmReleaseDatabaseMigration } from "@d4research/shared/cliRelease";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { Atom } from "effect/reactivity";

export interface NpmRelease {
  readonly version: string;
  /** Absent on releases published before npm manifests carried it. */
  readonly databaseMigration: number | undefined;
}

/** `spec` is an exact version or dist-tag; missing releases return null. */
const loadNpmRelease = Effect.fn("npm.loadRelease")(
  function* (spec: string) {
    const response = yield* HttpClient.get(
      `https://registry.npmjs.org/t3/${encodeURIComponent(spec)}`,
    );
    if (response.status === 404) return null;
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap((ok) => ok.json),
    );
    if (
      typeof body !== "object" ||
      body === null ||
      !("version" in body) ||
      typeof body.version !== "string"
    ) {
      return null;
    }
    return {
      version: body.version,
      databaseMigration: npmReleaseDatabaseMigration(body),
    } satisfies NpmRelease;
  },
  Effect.provideService(HttpClient.TracerPropagationEnabled, false),
  Effect.provide(FetchHttpClient.layer),
);

export const npmReleaseAtom = Atom.family((spec: string) =>
  Atom.make(loadNpmRelease(spec)).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.withLabel(`npm-release:${spec}`),
  ),
);

/** Publication checks run only when the user starts an update. */
export function isNpmReleasePublished(version: string): Promise<boolean> {
  return Effect.runPromise(loadNpmRelease(version)).then((release) => release?.version === version);
}
