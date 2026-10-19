import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { FetchHttpClient } from "effect/http";
import { ThreadId, ProjectId, ProviderInstanceId, EventId } from "@d4research/contracts";
import * as HandoffMemory from "./handoffMemory.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ServerConfig from "./config.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
// @effect-diagnostics nodeBuiltinImport:off -- MCP byte verification uses synchronous Node SHA-256 at the SDK boundary.
import * as NodeCrypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { MekoHandoffClient, mapMekoArguments, resolveMekoConnection } from "./mekoHandoff.ts";

const config = {
  url: "http://127.0.0.1:8090/mcp",
  tokenEnv: "",
  agentId: "d4research-test",
  datapackId: "test-datapack",
};
const input = {
  text: "The visible context, unchanged.",
  threadId: "thread-1",
  project: "project-1",
};
const tools = Object.entries({
  conversation_create: ["agent_id", "datapack_id", "session_id"],
  artifact_put: [
    "filename",
    "content_base64",
    "content_type",
    "conversation_id",
    "agent_id",
    "datapack_id",
  ],
  artifact_get: ["content_hash", "conversation_id", "agent_id", "datapack_id"],
}).map(([name, keys]) => ({
  name,
  inputSchema: {
    type: "object" as const,
    properties: Object.fromEntries(keys.map((key) => [key, { type: "string" }])),
    required: keys,
  },
}));

function corruptUtf8(encoded: string) {
  const bytes = Buffer.from(encoded, "base64");
  const index = bytes.indexOf(Buffer.from("\uFFFD"));
  return Buffer.concat([
    bytes.subarray(0, index),
    Buffer.from([0xff]),
    bytes.subarray(index + 3),
  ]).toString("base64");
}

function fakeMcp(
  options: {
    beforeWrite?: () => Promise<void>;
    mismatch?: boolean;
    malformedUtf8?: boolean;
    denied?: boolean;
    missingTool?: boolean;
    toolError?: boolean;
  } = {},
) {
  const calls: Array<{ name: string; arguments: Record<string, string> }> = [];
  let lists = 0;
  let stored = "";
  let contentHash = "";
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (options.denied) return new Response(null, { status: 403 });
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body));
    if (request.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (request.method === "initialize")
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-meko", version: "1" },
      };
    else if (request.method === "tools/list") {
      lists++;
      result = { tools: options.missingTool ? tools.slice(0, 1) : tools };
    } else if (request.method === "tools/call") {
      calls.push(request.params);
      let value: unknown;
      if (request.params.name === "conversation_create") value = { id: "test-conversation" };
      else if (request.params.name === "artifact_put") {
        await options.beforeWrite?.();
        stored = request.params.arguments.content_base64;
        contentHash = NodeCrypto.createHash("sha256")
          .update(Buffer.from(stored, "base64"))
          .digest("hex");
        value = { content_hash: contentHash };
      } else
        value = {
          content_hash: contentHash,
          content_base64: options.mismatch
            ? Buffer.from("wrong packet").toString("base64")
            : options.malformedUtf8
              ? corruptUtf8(stored)
              : stored,
        };
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify(options.toolError ? { error: "agent_id_mismatch" } : value),
          },
        ],
      };
    } else throw new Error(`Unexpected MCP method ${request.method}`);
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher, lists: () => lists };
}
afterEach(() => vi.unstubAllGlobals());

describe("Meko MCP handoff", () => {
  it("saves exact bytes, verifies by hash, collapses concurrent and repeated saves", async () => {
    const fake = fakeMcp();
    const client = new MekoHandoffClient();
    const [first, second] = await Promise.all([
      client.save(config, input),
      client.save(config, input),
    ]);
    expect(first.status).toBe("SUCCESS_WITH_EVIDENCE");
    expect(second).toEqual(first);
    expect(await client.save(config, input)).toEqual(first);
    expect(fake.calls.map((call) => call.name)).toEqual([
      "conversation_create",
      "artifact_put",
      "artifact_get",
    ]);
    expect(
      fake.calls.every(
        (call) =>
          call.arguments.agent_id === config.agentId &&
          call.arguments.datapack_id === config.datapackId,
      ),
    ).toBe(true);
    expect(JSON.stringify(client.status(config))).not.toContain(input.text);
  });

  it("reuses discovery but not a result across scope changes", async () => {
    const fake = fakeMcp();
    const client = new MekoHandoffClient();
    await client.save(config, input);
    await client.save(config, { ...input, text: "Second packet" });
    expect(fake.lists()).toBe(1);
    await client.save({ ...config, datapackId: "another-datapack" }, input);
    expect(fake.lists()).toBe(2);
    expect(fake.calls.filter((call) => call.name === "artifact_put")).toHaveLength(3);
  });

  it("never treats a mismatched readback as saved", async () => {
    fakeMcp({ mismatch: true });
    const client = new MekoHandoffClient();
    expect((await client.save(config, input)).status).toBe("ERROR_TOOL_FAILURE");
    expect(client.status(config).recent[0]?.contentHash).toBeUndefined();
  });

  it.each([{ denied: true }, { toolError: true }])(
    "keeps authorization failures distinct (%o)",
    async (options) => {
      fakeMcp(options);
      expect((await new MekoHandoffClient().save(config, input)).status).toBe(
        "ERROR_AUTH_RESTRICTED",
      );
    },
  );

  it("checks capabilities without writing and refuses an incompatible API", async () => {
    const fake = fakeMcp({ missingTool: true });
    const client = new MekoHandoffClient();
    expect((await client.check(config)).status).toBe("ERROR_CONFIGURATION");
    expect(fake.calls).toHaveLength(0);
  });

  it("retrieves a known key and rejects cross-thread context", async () => {
    fakeMcp();
    const client = new MekoHandoffClient();
    const saved = await client.save(config, input);
    const reference = {
      contentHash: saved.contentHash!,
      conversationId: saved.conversationId!,
      threadId: input.threadId,
      project: input.project,
    };
    expect((await client.read(config, reference)).text).toBe(input.text);
    const denied = await client.read(config, { ...reference, threadId: "other-thread" });
    expect(denied.receipt.status).toBe("ERROR_AUTH_RESTRICTED");
    expect(denied.text).toBeUndefined();
  });

  it("requires explicit endpoint and credentials without network access", async () => {
    const fake = fakeMcp();
    const client = new MekoHandoffClient();
    expect((await client.save({ ...config, url: "" }, input)).status).toBe("ERROR_CONFIGURATION");
    expect(() => resolveMekoConnection({ ...config, tokenEnv: "MISSING" }, {})).toThrow("missing");
    expect(() => resolveMekoConnection({ ...config, url: "http://example.test/mcp" })).toThrow(
      "Use HTTPS",
    );
    expect(fake.fetcher).not.toHaveBeenCalled();
  });

  it("validates discovered input types and drops unadvertised arguments", () => {
    const tool = tools[0]!;
    expect(
      mapMekoArguments(tool, { agent_id: "a", datapack_id: "d", session_id: "s", ignored: "x" }),
    ).toEqual({ agent_id: "a", datapack_id: "d", session_id: "s" });
    expect(() =>
      mapMekoArguments(tool, { agent_id: 3, datapack_id: "d", session_id: "s" }),
    ).toThrow("schema");
    expect(() => mapMekoArguments(tool, {})).toThrow("unsupported argument");
  });
});

it("limits concurrent operations and aborts active requests without disclosing credentials", async () => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          entered();
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("test-credential-value")),
            { once: true },
          );
        }),
    ),
  );
  const client = new MekoHandoffClient();
  const first = client.save(config, input);
  const second = client.save(config, { ...input, text: "Second checkpoint" });
  await started;
  expect((await client.save(config, { ...input, text: "Third checkpoint" })).status).toBe(
    "ERROR_BUSY",
  );
  client.cancel();
  const receipts = await Promise.all([first, second]);
  expect(receipts.every((receipt) => receipt.status === "ERROR_TIMEOUT")).toBe(true);
  expect(JSON.stringify(receipts)).not.toContain("test-credential-value");
});

it("does not put a configured credential in receipts or the ledger", async () => {
  const variable = "MEKO_TEST_CREDENTIAL";
  vi.stubEnv(variable, "test-credential-value");
  try {
    fakeMcp({ denied: true });
    const client = new MekoHandoffClient();
    const selected = { ...config, tokenEnv: variable };
    const receipt = await client.check(selected);
    expect(receipt.status).toBe("ERROR_AUTH_RESTRICTED");
    expect(JSON.stringify([receipt, client.status(selected)])).not.toContain(
      "test-credential-value",
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

effectIt.effect(
  "schedules verified saves without blocking and disables later saves and recall",
  () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fake = fakeMcp({
      beforeWrite: () => {
        entered.resolve();
        return release.promise;
      },
    });
    const dependencies = Layer.mergeAll(
      ServerSettings.layerTest({ handoff: { memoryBackend: "meko", meko: config } }),
      ProjectionStore.layerMemory,
      Path.layer,
      FetchHttpClient.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "meko-service-test-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* HandoffMemory.HandoffMemory;
      const settings = yield* ServerSettings.ServerSettingsService;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make(input.threadId);
      const instanceId = ProviderInstanceId.make("test-provider");
      const now = yield* DateTime.now;
      yield* store.apply({
        type: "thread.created",
        id: EventId.make("test-event"),
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          projectId: ProjectId.make(input.project),
          title: "Test thread",
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "test-model" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          deletedAt: null,
          createdBy: "user",
          creationSource: "web",
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
        },
      });
      yield* service.schedule(input);
      yield* Effect.promise(() => entered.promise);
      expect(fake.calls.map((call) => call.name)).toEqual(["conversation_create", "artifact_put"]);
      release.resolve();
      const saved = yield* service.save(input);
      expect(saved.ok).toBe(true);
      const reference = {
        ...input,
        conversationId: saved.receipt!.conversationId!,
        contentHash: saved.receipt!.contentHash!,
      };
      expect((yield* service.read(reference, input.threadId)).text).toBe(input.text);
      expect(
        (yield* service.read({ ...reference, project: "other-project" }, input.threadId)).text,
      ).toBeUndefined();
      yield* settings.updateSettings({ handoff: { memoryBackend: "none" } });
      const calls = fake.fetcher.mock.calls.length;
      expect((yield* service.save({ ...input, text: "Changed checkpoint" })).ok).toBe(false);
      expect((yield* service.read(reference, input.threadId)).text).toBeUndefined();
      expect(fake.fetcher.mock.calls).toHaveLength(calls);
    }).pipe(
      Effect.scoped,
      Effect.provide(HandoffMemory.layer.pipe(Layer.provideMerge(dependencies))),
    );
  },
);

it("bounds a stalled MCP connection with a timeout receipt", async () => {
  vi.useFakeTimers();
  const started = Promise.withResolvers<void>();
  vi.stubGlobal(
    "fetch",
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        started.resolve();
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  );
  try {
    const pending = new MekoHandoffClient().check(config);
    await started.promise;
    await vi.advanceTimersByTimeAsync(12_000);
    expect((await pending).status).toBe("ERROR_TIMEOUT");
  } finally {
    vi.useRealTimers();
  }
});

it("rejects different bytes that decode to the same Unicode text on save and recall", async () => {
  const corruption = { malformedUtf8: true };
  fakeMcp(corruption);
  const client = new MekoHandoffClient();
  const unicodeInput = { ...input, text: "A replacement character: \uFFFD" };
  expect((await client.save(config, unicodeInput)).status).toBe("ERROR_TOOL_FAILURE");
  corruption.malformedUtf8 = false;
  const saved = await client.save(config, unicodeInput);
  expect(saved.status).toBe("SUCCESS_WITH_EVIDENCE");
  corruption.malformedUtf8 = true;
  const recalled = await client.read(config, {
    ...input,
    contentHash: saved.contentHash!,
    conversationId: saved.conversationId!,
  });
  expect(recalled.receipt.status).toBe("ERROR_TOOL_FAILURE");
  expect(recalled.text).toBeUndefined();
});
