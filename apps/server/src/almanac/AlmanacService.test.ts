import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeURL from "node:url";

import * as ServerSettings from "../serverSettings.ts";
import * as Almanac from "./AlmanacService.ts";

const fake = NodeURL.fileURLToPath(new URL("./fakeAlmanacServer.testkit.mjs", import.meta.url));

const withCommand = (command: string) =>
  Almanac.layer.pipe(Layer.provide(ServerSettings.layerTest({ almanac: { command } })));

describe("AlmanacService", () => {
  it.effect("reports an unset command without starting a process", () =>
    Effect.gen(function* () {
      const service = yield* Almanac.AlmanacService;
      expect(yield* service.status()).toEqual({ configured: false, connected: false });
      const failure = yield* Effect.flip(service.browse({ path: "", offset: 0 }));
      expect(failure.code).toBe("not_configured");
    }).pipe(Effect.provide(withCommand(""))),
  );

  it.effect("reports a configured command that cannot start", () =>
    Effect.gen(function* () {
      const service = yield* Almanac.AlmanacService;
      expect(yield* service.status()).toEqual({ configured: true, connected: false });
    }).pipe(Effect.provide(withCommand("exit 7"))),
  );

  it.effect("talks to a real stdio MCP server and maps its replies", () =>
    Effect.gen(function* () {
      const service = yield* Almanac.AlmanacService;
      expect(yield* service.status()).toEqual({ configured: true, connected: true });
      const browsed = yield* service.browse({ path: "/work", offset: 0 });
      expect(browsed.categories).toEqual([{ path: "/work", items: 2 }]);
      const read = yield* service.read({ sourceId: "7e36da31-f6d0-4ffe-b13c-47151534d90b" });
      expect(read.content).toBe("line one\nline two");
      expect(yield* service.remember({ text: "A fact" })).toEqual({ result: "created A fact" });
      expect(
        yield* service.update({ memoryId: "7e36da31-f6d0-4ffe-b13c-47151534d90b", text: "New" }),
      ).toEqual({ result: "updated v4" });
      const refused = yield* Effect.flip(
        service.forget({ memoryId: "7e36da31-f6d0-4ffe-b13c-47151534d90b" }),
      );
      expect(refused.code).toBe("rejected");
    }).pipe(Effect.provide(withCommand(`exec ${process.execPath} ${fake}`))),
  );
});
