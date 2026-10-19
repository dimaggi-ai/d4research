import { expect, it } from "vite-plus/test";
import * as NodeWorkerThreads from "node:worker_threads";
import { javascriptTestDocument } from "./javascriptTest";
function workerSource(code: string) {
  const html = javascriptTestDocument(code);
  const match = html.match(/new Blob\(\[(".*")\], \{type:/);
  if (!match) throw new Error("Worker source missing");
  return JSON.parse(match[1]!) as string;
}
async function run(code: string) {
  const source = `const {parentPort} = require('node:worker_threads'); const self = globalThis; const postMessage = value => parentPort.postMessage(value); ${workerSource(code)}`;
  const worker = new NodeWorkerThreads.Worker(source, { eval: true });
  return new Promise<{ ok: boolean; logs?: string[]; error?: string }>((resolve) => {
    const timeout = setTimeout(() => {
      void worker.terminate();
      resolve({ ok: false, error: "timeout" });
    }, 2000);
    worker.on("message", (result) => {
      clearTimeout(timeout);
      void worker.terminate();
      resolve(result);
    });
    worker.on("error", (error) => {
      clearTimeout(timeout);
      void worker.terminate();
      resolve({ ok: false, error: error.message });
    });
  });
}
it("runs actual JavaScript assertions and captures results", async () => {
  expect(await run("assert(2+2===4); console.log('ok')")).toEqual({ ok: true, logs: ["ok"] });
  expect(await run("assert(false, 'wrong')")).toEqual({
    ok: false,
    logs: [],
    error: "Error: wrong",
  });
});
it("terminates an infinite loop and disables fetch in the worker", async () => {
  expect(await run("while(true) {} ")).toEqual({ ok: false, error: "timeout" });
  expect((await run("assert(typeof fetch === 'undefined')")).ok).toBe(true);
});
it("escapes closing script tags and declares network isolation", () => {
  const html = javascriptTestDocument("console.log('</script><img src=evil>')");
  expect(html.match(/<\/script>/g)).toHaveLength(1);
  expect(html).toContain("connect-src 'none'");
});
