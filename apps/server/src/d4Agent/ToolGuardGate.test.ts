// @effect-diagnostics-next-line nodeBuiltinImport:off -- A real HTTP fixture stands in for tg-proxy.
import * as NodeHttp from "node:http";
import { afterEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ToolGuard from "./ToolGuardGate.ts";

const servers: Array<NodeHttp.Server> = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function fake(status: number, body: string) {
  const bodies: Array<string> = [];
  const server = NodeHttp.createServer((req, res) => {
    let received = "";
    req.on("data", (chunk) => (received += chunk));
    req.on("end", () => {
      bodies.push(`${req.method} ${req.url} ${received}`);
      res.statusCode = status;
      res.end(body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing address");
  return { url: `http://127.0.0.1:${address.port}`, bodies };
}

const envelope: ToolGuard.ToolGuardEnvelope = {
  envelope_id: "e1",
  agent_id: "nia",
  session_id: "s",
  org_id: "d4research",
  tool_name: "d4_agent_action",
  tool_group: "d4_agent",
  parameters: { action_type: "interrupt" },
};

it.live(
  "reads the matched rule from an escalation",
  Effect.fnUntraced(function* () {
    const proxy = yield* Effect.promise(() =>
      fake(
        202,
        JSON.stringify({
          decision: "escalated",
          decision_reason: "Escalated by: [nia-escalate-interrupt]",
          rule_results: [
            { rule_id: "nia-deny-send", matched: false },
            { rule_id: "nia-escalate-interrupt", matched: true },
          ],
        }),
      ),
    );
    expect(yield* ToolGuard.evaluateWithProxy(proxy.url, envelope)).toEqual({
      decision: "escalated",
      rule: "nia-escalate-interrupt",
      reason: "Escalated by: [nia-escalate-interrupt]",
    });
    expect(proxy.bodies).toEqual([`POST /evaluate ${JSON.stringify(envelope)}`]);
  }),
);

it.live(
  "reports a broken, failing or remote proxy as unavailable",
  Effect.fnUntraced(function* () {
    const failing = yield* Effect.promise(() => fake(500, "{}"));
    const garbled = yield* Effect.promise(() => fake(200, '{"decision":"maybe"}'));
    for (const url of [failing.url, garbled.url, "http://example.com:9191", "not a url"])
      expect((yield* ToolGuard.evaluateWithProxy(url, envelope)).decision).toBe("unavailable");
  }),
);
