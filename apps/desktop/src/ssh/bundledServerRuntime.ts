import { BundledServerRuntime } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(BundledServerRuntime));

/** No public-release fallback: the payload and identity must come from this installed app. */
export const readBundledServerRuntime = Effect.fn("desktop.ssh.readBundledServerRuntime")(
  function* (
    environment: Pick<
      DesktopEnvironment.DesktopEnvironment["Service"],
      "isPackaged" | "resourcesPath" | "path"
    >,
  ) {
    const fs = yield* FileSystem.FileSystem;
    if (!environment.isPackaged) return null;
    const directory = environment.path.join(environment.resourcesPath, "server-runtime");
    const manifest = environment.path.join(directory, "manifest.json");
    if (!(yield* fs.exists(manifest))) return null;
    const metadata = yield* decodeManifest(yield* fs.readFileString(manifest));
    const archivePath = environment.path.join(directory, "runtime.tar.gz");
    if (!(yield* fs.exists(archivePath))) return null;
    return { metadata, archivePath };
  },
);
