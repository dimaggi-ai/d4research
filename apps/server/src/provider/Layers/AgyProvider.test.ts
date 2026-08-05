// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { AgySettings } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { checkAgyProviderStatus } from "./AgyProvider.ts";

const decodeSettings = Schema.decodeSync(AgySettings);

it.layer(NodeServices.layer)("Agy provider health", (it) => {
  it.effect("keeps model discovery ready when the version probe fails", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d2-agy-health-")),
      );
      const binary = NodePath.join(directory, "agy");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          binary,
          '#!/bin/sh\nif [ "$1" = "models" ]; then echo "gemini-test"; exit 0; fi\necho "version unavailable" >&2\nexit 1\n',
          { mode: 0o755 },
        ),
      );

      const snapshot = yield* checkAgyProviderStatus(
        decodeSettings({ binaryPath: binary }),
        process.env,
      );
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBeNull();
      expect(snapshot.models.map((model) => model.slug)).toContain("gemini-test");
    }),
  );

  it.effect("reports bounded model discovery stderr", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "d2-agy-health-")),
      );
      const binary = NodePath.join(directory, "agy");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(binary, '#!/bin/sh\necho "connector config is invalid" >&2\nexit 1\n', {
          mode: 0o755,
        }),
      );

      const snapshot = yield* checkAgyProviderStatus(
        decodeSettings({ binaryPath: binary }),
        process.env,
      );
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("connector config is invalid");
    }),
  );
});
