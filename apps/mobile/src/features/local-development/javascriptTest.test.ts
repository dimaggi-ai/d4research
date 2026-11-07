import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { Effect, Option } from "effect";
import * as NodeWorkerThreads from "node:worker_threads";
import { javascriptTestDocument } from "./javascriptTest";
function workerSource(code: string) {
  const html = javascriptTestDocument(code);
  const match = html.match(/new Blob\(\[(".*")\], \{type:/);
  if (!match) throw new Error("Worker source missing");
  return JSON.parse(match[1]!) as string;
}
function run(code: string) {
  return Effect.gen(function* () {
    const source = `const {parentPort} = require('node:worker_threads'); const self = globalThis; const postMessage = value => parentPort.postMessage(value); ${workerSource(code)}`;
    const worker = new NodeWorkerThreads.Worker(source, { eval: true });
    return yield* Effect.promise(
      () =>
        new Promise<{ ok: boolean; logs?: string[]; error?: string }>((resolve) => {
          worker.once("message", resolve);
          worker.once("error", (error) => resolve({ ok: false, error: error.message }));
        }),
    ).pipe(
      Effect.timeoutOption("2 seconds"),
      Effect.map(Option.getOrElse(() => ({ ok: false, error: "timeout" }))),
      Effect.ensuring(Effect.promise(() => worker.terminate())),
    );
  });
}
it.live("runs actual JavaScript assertions and captures results", () =>
  Effect.gen(function* () {
    expect(yield* run("assert(2+2===4); console.log('ok')")).toEqual({ ok: true, logs: ["ok"] });
    expect(yield* run("assert(false, 'wrong')")).toEqual({
      ok: false,
      logs: [],
      error: "Error: wrong",
    });
  }),
);
it.live("terminates an infinite loop and disables fetch in the worker", () =>
  Effect.gen(function* () {
    expect(yield* run("while(true) {} ")).toEqual({ ok: false, error: "timeout" });
    expect((yield* run("assert(typeof fetch === 'undefined')")).ok).toBe(true);
  }),
);
it("escapes closing script tags and declares network isolation", () => {
  const html = javascriptTestDocument("console.log('</script><img src=evil>')");
  expect(html.match(/<\/script>/g)).toHaveLength(1);
  expect(html).toContain("connect-src 'none'");
});
