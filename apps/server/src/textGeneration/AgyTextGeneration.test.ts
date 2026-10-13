import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AgySettings, ProviderInstanceId } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeAgyTextGeneration } from "./AgyTextGeneration.ts";

const settingsFrom = Schema.decodeSync(AgySettings);

it.layer(NodeServices.layer)("Agy text generation", (it) => {
  it.effect("decodes a review guide from the CLI JSON envelope", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped();
      const binaryPath = path.join(cwd, "agy");
      yield* fs.writeFileString(
        binaryPath,
        `#!/usr/bin/env node
process.stdout.write('{"status":"SUCCESS","response":{"stops":[]}}');
`,
      );
      yield* fs.chmod(binaryPath, 0o755);
      const service = yield* makeAgyTextGeneration(settingsFrom({ binaryPath }));
      const result = yield* service.generateReviewGuide({
        cwd,
        modelSelection: { instanceId: ProviderInstanceId.make("agy"), model: "default" },
        number: 1,
        title: "Fix transport",
        description: "",
        baseBranch: "main",
        baseCommit: "abc123",
        settledReview: "",
      });
      assert.deepEqual(result, { stops: [] });
    }),
  );
});
