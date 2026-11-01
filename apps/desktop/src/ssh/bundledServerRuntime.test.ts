import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { readBundledServerRuntime } from "./bundledServerRuntime.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const metadata = {
  version: "0.1.1",
  buildId: "a".repeat(64),
  sha256: "b".repeat(64),
  os: "darwin",
  arch: "arm64",
};

it.layer(NodeServices.layer)("bundled desktop server asset", (it) => {
  it.effect("reads only a complete packaged runtime and its declared build identity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resourcesPath = yield* fs.makeTempDirectoryScoped();
      const input = { isPackaged: true, resourcesPath, path };
      assert.isNull(yield* readBundledServerRuntime(input));
      yield* fs.makeDirectory(path.join(resourcesPath, "server-runtime"));
      yield* fs.writeFileString(
        path.join(resourcesPath, "server-runtime/manifest.json"),
        yield* encodeJson(metadata),
      );
      assert.isNull(yield* readBundledServerRuntime(input));
      yield* fs.writeFileString(
        path.join(resourcesPath, "server-runtime/runtime.tar.gz"),
        "fixture",
      );
      const runtime = yield* readBundledServerRuntime(input);
      assert.deepStrictEqual(runtime?.metadata, metadata);
      assert.strictEqual(
        runtime?.archivePath,
        path.join(resourcesPath, "server-runtime/runtime.tar.gz"),
      );
    }).pipe(Effect.scoped),
  );
  it.effect("refuses a malformed manifest instead of selecting a public runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resourcesPath = yield* fs.makeTempDirectoryScoped();
      const input = { isPackaged: true, resourcesPath, path };
      yield* fs.makeDirectory(path.join(resourcesPath, "server-runtime"));
      yield* fs.writeFileString(
        path.join(resourcesPath, "server-runtime/manifest.json"),
        yield* encodeJson({ ...metadata, buildId: "../other" }),
      );
      const result = yield* readBundledServerRuntime(input).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
    }).pipe(Effect.scoped),
  );
});
