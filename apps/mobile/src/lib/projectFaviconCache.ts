import {
  createProjectFaviconCache,
  createProjectFaviconImageLoader,
  PROJECT_FAVICON_MAX_DATA_URL_LENGTH,
  PROJECT_FAVICON_THUMBNAIL_SIZE,
  type ProjectFaviconEntry,
} from "@d4research/client-runtime/project-favicon-cache";
import * as Effect from "effect/Effect";

import * as MobileDatabase from "../persistence/mobile-database";

const CACHE_KIND = "project-favicon";
const CACHE_SCHEMA_VERSION = 1;

let database: MobileDatabase.MobileDatabase["Service"] | undefined;

/**
 * The cache is a module singleton because the favicon atom family holds it outside
 * any Effect runtime. Its rows live in `client_cache`, so the environment cache store
 * hands over the database it already owns instead of the cache re-entering the runtime.
 */
export function attachProjectFaviconDatabase(service: MobileDatabase.MobileDatabase["Service"]) {
  database = service;
}

const runDatabase = <A, E>(
  use: (database: MobileDatabase.MobileDatabase["Service"]) => Effect.Effect<A, E>,
) =>
  database
    ? Effect.runPromise(use(database))
    : Promise.reject(new Error("Project icon storage is not attached."));

/**
 * Rasterizes oversized icons using Expo's native image decoder and encoder.
 * Temporary thumbnails are removed immediately after their bytes are read.
 */
export async function downscaleProjectFavicon(
  image: { readonly url: string },
  signal: AbortSignal,
) {
  const [{ Image }, { File }, { ImageManipulator, SaveFormat }] = await Promise.all([
    import("expo-image"),
    import("expo-file-system"),
    import("expo-image-manipulator"),
  ]);
  for (const size of [PROJECT_FAVICON_THUMBNAIL_SIZE, PROJECT_FAVICON_THUMBNAIL_SIZE / 2]) {
    signal.throwIfAborted();
    const decoded = await Image.loadAsync(image.url, { maxWidth: size, maxHeight: size });
    try {
      signal.throwIfAborted();
      if (decoded.width > size || decoded.height > size) {
        throw new Error("Project icon was not resized.");
      }
      const context = ImageManipulator.manipulate(decoded);
      try {
        const rendered = await context.renderAsync();
        try {
          const result = await rendered.saveAsync({ format: SaveFormat.PNG });
          const file = new File(result.uri);
          try {
            signal.throwIfAborted();
            if (file.size > PROJECT_FAVICON_MAX_DATA_URL_LENGTH) continue;
            const dataUrl = `data:image/png;base64,${await file.base64()}`;
            if (dataUrl.length <= PROJECT_FAVICON_MAX_DATA_URL_LENGTH) return dataUrl;
          } finally {
            file.delete();
          }
        } finally {
          rendered.release();
        }
      } finally {
        context.release();
      }
    } finally {
      decoded.release();
    }
  }
  throw new Error("Project icon thumbnail exceeds the cache limit.");
}

/** Rows live in `client_cache` so Settings → Client storage counts and clears them. */
export const projectFaviconCache = createProjectFaviconCache({
  storage: {
    list: () =>
      runDatabase((database) =>
        database.listCache(CACHE_KIND).pipe(
          Effect.map((payloads) =>
            payloads.flatMap((payload): Array<unknown> => {
              try {
                return [JSON.parse(payload)];
              } catch {
                return [];
              }
            }),
          ),
        ),
      ),
    put: (key, entry: ProjectFaviconEntry) =>
      runDatabase((database) =>
        database.saveCache(
          entry.environmentId,
          CACHE_KIND,
          key,
          CACHE_SCHEMA_VERSION,
          JSON.stringify(entry),
        ),
      ),
    remove: (key, entry) =>
      runDatabase((database) => database.removeCache(entry.environmentId, CACHE_KIND, key)),
  },
  load: createProjectFaviconImageLoader({ downscale: downscaleProjectFavicon }),
});
