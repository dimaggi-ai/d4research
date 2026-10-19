import { it, expect } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer, McpSchema } from "effect/ai";
import { BrainToolkit } from "./tools.ts";
import { BrainToolkitHandlersLive } from "./handlers.ts";
import { toolkitRegistration } from "../../McpHttpServer.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { withBrain } from "../../../second-brain/testkit.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const edit = {
  path: "notes/test.md",
  kind: "note",
  operation: "create",
  content: "# Test",
  expectedHash: null,
  rationale: "requested",
  evidence: [],
};
const scope = (
  access: "read-only" | "full-access",
  provider = false,
): Invocation.McpInvocationScope => ({
  environmentId: EnvironmentId.make("test"),
  requestNamespace: "test",
  issuedAt: 0,
  capabilities: new Set(),
  thread: provider
    ? {
        threadId: ThreadId.make("thread"),
        providerSessionId: "s",
        providerInstanceId: ProviderInstanceId.make("codex"),
      }
    : undefined,
  client: provider ? undefined : { sessionId: "c", label: "test", access },
});
function call(tool: string, access: "read-only" | "full-access", provider = false, active = true) {
  const registration = toolkitRegistration(BrainToolkit, BrainToolkitHandlersLive).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed(liveThreadShell(id, active ? {} : { activeRunId: null })),
      }),
    ),
  );
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({
      name: tool,
      arguments: tool === "brain_reindex" ? {} : edit,
    });
    return result.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
  }).pipe(
    Effect.provide(registration),
    Effect.provideService(Invocation.McpInvocationContext, scope(access, provider)),
    Effect.provideService(McpSchema.McpServerClient, client),
  );
}
it.effect.each(["brain_propose", "brain_write", "brain_reindex"])(
  "refuses %s to read-only clients",
  (tool) =>
    withBrain(() =>
      call(tool, "read-only").pipe(
        Effect.map((text) => expect(text).toContain("approved for read-only access")),
      ),
    ),
);
it.effect("refuses expired provider writes", () =>
  withBrain(() =>
    call("brain_propose", "full-access", true, false).pipe(
      Effect.map((text) => expect(text).toContain("no longer owns an active thread run")),
    ),
  ),
);
it.effect("allows a live provider to propose", () =>
  withBrain(() =>
    call("brain_propose", "full-access", true).pipe(
      Effect.map((text) => expect(text).toContain('"pending"')),
    ),
  ),
);
it.effect("allows a writable client to propose but enforces review mode for writes", () =>
  withBrain(() =>
    Effect.gen(function* () {
      expect(yield* call("brain_propose", "full-access")).toContain('"pending"');
      expect(yield* call("brain_write", "full-access")).toContain("Use brain_propose");
    }),
  ),
);
it("exposes exactly the ten Phase A tools and no review operation", () => {
  expect(Object.keys(BrainToolkit.tools).sort()).toEqual([
    "brain_backlinks",
    "brain_lint",
    "brain_map",
    "brain_proposals",
    "brain_propose",
    "brain_read",
    "brain_reindex",
    "brain_search",
    "brain_status",
    "brain_write",
  ]);
});
