#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeReadline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("Muse Code 1.3.0\n");
  process.exit(0);
}
let initialized = false;
let granted: string[] = [];
let sequence = 0;
let turnId = "";
let sessionId = "mock-muse-session";
let modelId = "muse-spark-1.3";
const sessionPath = () => process.env.T3_MSP_SESSION_PATH ?? "/tmp/session.jsonl";
const patchBody = () =>
  process.env.T3_MSP_PATCH_BODY ??
  JSON.stringify({
    files: [
      {
        hunks: [{ lines: ["-old", "+new"], newLines: 1, newStart: 1, oldLines: 1, oldStart: 1 }],
        path: "file.txt",
      },
    ],
  });
let waiting = "";
const sourceRange = {
  first: { id: "record", sequence: 1 },
  last: { id: "record", sequence: 1 },
  stream: { id: "stream", kind: "session" },
};
const usage = { inputTokens: 10, cachedTokens: 2, outputTokens: 3, reasoningTokens: 1 };
const send = (frame: object) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
const notify = (method: string, params: object) =>
  send({
    method,
    params: { sessionId, viewCursor: `cursor-${++sequence}`, sourceRange, ...params },
  });
const request = (method: string, params: object) =>
  send({
    id: `host-${++sequence}`,
    method,
    params: { sessionId, viewCursor: `cursor-${sequence}`, sourceRange, ...params },
  });
// The real host emits a last gasp on SIGTERM before dying: the adapter must
// ignore frames from a retired host, or a plan-mode respawn kills its own
// event pump. Mirror that here so the plan tests cover it. writeSync keeps
// the frames from being cut off by the exit.
process.on("SIGTERM", () => {
  for (const [method, params] of [
    ["session/closed", { reason: "hostShutdown", viewCursor: "" }],
    ["session/statusChanged", { status: "notLoaded", viewCursor: "" }],
  ] as const) {
    NodeFS.writeSync(
      1,
      `${JSON.stringify({ jsonrpc: "2.0", method, params: { sessionId, ...params } })}\n`,
    );
  }
  process.exit(0);
});
const item = (kind: string, data: object = {}) => ({
  itemId: `${kind}-${turnId}`,
  kind,
  revision: 1,
  status: "inProgress",
  turnId,
  ...data,
});
function finish(terminal = "completed") {
  notify("turn/completed", {
    turnId,
    terminal,
    usage,
    ...(process.env.T3_MSP_FAIL_AUTH === "1"
      ? {
          terminal: "failed",
          error: { kind: "authRequired", message: "not logged in", retryable: false },
        }
      : {}),
  });
}
function emitTurn() {
  notify("turn/started", { turnId, commandId: turnId });
  const message = item("agentMessage");
  const text = process.env.T3_MSP_RESPONSE_TEXT ?? "Hello from Muse";
  notify("item/started", { item: message });
  notify("item/delta", { itemId: message.itemId, delta: text });
  notify("item/completed", { item: { ...message, status: "completed", revision: 2, text } });
  if (process.env.T3_MSP_EMIT_REASONING === "1") {
    const reasoning = item("reasoning");
    notify("item/started", { item: reasoning });
    notify("item/delta", { itemId: reasoning.itemId, field: "summary.0", delta: "Thinking" });
  }
  if (process.env.T3_MSP_EMIT_TOOL === "1") {
    const tool = item("toolCall", {
      tool: "apply_patch",
      args: '{"path":"file.txt"}',
      callId: "call",
      patchRef: {
        availability: "available",
        byteLen: 1,
        id: "patch-tool",
        kind: "tool_patch",
        mediaType: "application/json",
        uri: "tool-output://local/patch-tool",
      },
      patchSummary: { added: 2, removed: 1, files: 1 },
    });
    notify("item/started", { item: tool });
    notify("item/delta", { itemId: tool.itemId, field: "output", delta: "Edited" });
    notify("item/updated", { item: { ...tool, revision: 2, visibleOutput: "Edited" } });
    notify("item/completed", { item: { ...tool, revision: 3, status: "completed" } });
  }
  notify("item/completed", {
    item: item("reminderChild", {
      status: "completed",
      fallbackText: "Reminder complete",
      childSessionId: "child",
    }),
  });
  notify("session/tokenUsage", {
    turnId,
    usage,
    promptTokens: 10,
    totalTokens: 13,
    cumulative: { promptTokens: 10, outputTokens: 3, totalTokens: 13 },
  });
  notify("session/contextUsage", { usedTokens: 13, windowTokens: 1000, pressure: "normal" });
  if (process.env.T3_MSP_EMIT_APPROVAL === "1") {
    waiting = "approval";
    request("approval/request", {
      approvalId: "approval",
      currentRequirementId: { approvalId: "approval", sourceIndex: 0 },
      itemId: "tool",
      taskId: "task",
      toolCallId: "call",
      turnId,
      toolName: "shell",
      rawArgs: "{}",
      protectedWrite: process.env.T3_MSP_PROTECTED_WRITE === "1",
      judgeEscalated: false,
      subject: { kind: "shell", command: "pwd" },
      availableChoices: [
        { choiceId: "allow", decision: "approved", label: "Allow", scope: "once" },
        {
          choiceId: "deny",
          decision: "denied",
          label: "Deny",
          scope: "once",
          acceptsFeedback: true,
        },
      ],
    });
  } else if (process.env.T3_MSP_EMIT_USER_INPUT === "1") {
    waiting = "input";
    request("userInput/request", {
      userInputId: "input",
      itemId: "tool",
      toolCallId: "call",
      toolName: "ask",
      turnId,
      questions: [
        {
          id: "q",
          header: "Choice",
          question: "Choose a color",
          options: [{ label: "Blue" }, { label: "Green" }],
          selection: { mode: process.env.T3_MSP_MULTISELECT === "1" ? "multiple" : "single" },
        },
      ],
    });
  } else if (process.env.T3_MSP_HANG_TURN !== "1") finish();
}
interface Frame {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}
for await (const line of NodeReadline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line) as Frame;
  if (process.env.T3_MSP_REQUEST_LOG_PATH)
    NodeFS.appendFileSync(process.env.T3_MSP_REQUEST_LOG_PATH, `${line}\n`);
  const p = frame.params ?? {};
  const respond = (result: unknown) => send({ id: frame.id, result });
  const reject = (kind: string, reason?: string) =>
    send({
      id: frame.id,
      error: { code: -32010, message: kind, data: { kind, ...(reason ? { reason } : {}) } },
    });
  if (!frame.method) continue;
  if (frame.method === "initialize") {
    const requested = (p.capabilities as { requestedCapabilities?: unknown } | undefined)
      ?.requestedCapabilities;
    const grantable = new Set(["sessionMcp", "userShell"]);
    granted = Array.isArray(requested)
      ? (requested as unknown[]).filter(
          (capability): capability is string =>
            typeof capability === "string" && grantable.has(capability),
        )
      : [];
    if (process.env.T3_MSP_DENY_SESSION_MCP === "1")
      granted = granted.filter((capability) => capability !== "sessionMcp");
    respond({
      experimentalApi: false,
      grantedCapabilities: granted,
      museHome: process.env.T3_MSP_MUSE_HOME ?? "/tmp/muse-mock",
      platformFamily: "unix",
      platformOs: "linux",
      schema: { fingerprint: "mock", version: 1 },
      serverInfo: { name: "muse", version: "1.3.0" },
      userAgent: "mock",
    });
    continue;
  }
  if (frame.method === "initialized") {
    initialized = true;
    continue;
  }
  if (!initialized) {
    reject("notInitialized");
    continue;
  }
  if (
    !["model/list", "item/readOutput", "session/list"].includes(frame.method) &&
    (typeof p.commandId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.commandId))
  ) {
    reject("invalidParams", "commandId must be UUIDv7");
    continue;
  }
  if (
    process.env.T3_MSP_APPROVAL_CEILING === "1" &&
    (p.approvalMode === "onRequest" || p.mode === "onRequest")
  ) {
    reject("commandRejected", "approval_mode_ceiling");
    continue;
  }
  switch (frame.method) {
    case "model/list":
      respond({
        models:
          process.env.T3_MSP_MODELS === ""
            ? []
            : [
                {
                  modelId,
                  displayLabel: "Muse Spark",
                  isActive: false,
                  isDefault: true,
                  contextLimit: 1000,
                  cost: null,
                  description: null,
                  outputLimit: null,
                  profileId: null,
                  providerId: "meta",
                  releaseDate: null,
                },
              ],
        profileId: null,
        providerId: "meta",
        source: "fakeCatalog",
      });
      break;
    case "session/start":
    case "session/resume": {
      if (
        (p.config as { mcpServers?: unknown } | undefined)?.mcpServers !== undefined &&
        !granted.includes("sessionMcp")
      ) {
        send({
          id: frame.id,
          error: {
            code: -32010,
            message: "session MCP configuration requires the sessionMcp capability",
            data: { kind: "capabilityRequired", capability: "sessionMcp", retryable: false },
          },
        });
        break;
      }
      if (p.sessionId === "missing") {
        reject("sessionNotFound");
        break;
      }
      if (p.sessionId === "busy") {
        reject("sessionInUse");
        break;
      }
      if (typeof p.sessionId === "string") sessionId = p.sessionId;
      if (typeof p.modelId === "string") modelId = p.modelId;
      respond({
        session: {
          sessionId,
          activeTurnId: null,
          createdAt: "2026-09-16T00:00:00Z",
          updatedAt: "2026-09-16T00:00:00Z",
          forkedFrom: null,
          modelId,
          providerId: "meta",
          path: sessionPath(),
          status: "idle",
          turnCount: 0,
          workspaceRoot: process.cwd(),
        },
        viewCursor: `cursor-${sequence}`,
        history: { mode: "none" },
        pendingRequests: [],
      });
      break;
    }
    case "item/readOutput": {
      if (process.env.T3_MSP_READOUTPUT_FAIL === "1") {
        send({
          id: frame.id,
          error: {
            code: -32010,
            message: "output unavailable",
            data: { kind: "outputUnavailable", retryable: false },
          },
        });
        break;
      }
      const content = patchBody();
      respond({
        byteLen: content.length,
        content,
        encoding: "utf8",
        eof: true,
        mediaType: "application/json",
        offsetBytes: 0,
      });
      break;
    }
    case "session/list":
      respond({ nextCursor: null, sessions: [] });
      break;
    case "turn/start": {
      if (process.env.T3_MSP_EXIT_ON_TURN === "1") {
        process.stderr.write("mock host exited\n");
        process.exit(2);
      }
      turnId = String(p.commandId);
      respond({
        commandId: p.commandId,
        turnId,
        status: "accepted",
        startedNewTurn: true,
        disposition: "started",
      });
      emitTurn();
      break;
    }
    case "turn/interrupt":
      respond({ commandId: p.commandId, turnId, status: "accepted" });
      waiting = "";
      finish("cancelled");
      break;
    case "session/compact":
      respond({
        commandId: p.commandId,
        status: process.env.T3_MSP_COMPACT_NOOP === "1" ? "noop" : "accepted",
      });
      if (process.env.T3_MSP_COMPACT_NOOP !== "1")
        notify("item/completed", {
          item: item("compaction", {
            status: "completed",
            tokensBefore: 100,
            tokensAfter: 20,
            outcome: "installed",
          }),
        });
      break;
    case "approval/decide": {
      if (waiting !== "approval") {
        reject("approvalNotFound");
        break;
      }
      if (process.env.T3_MSP_STALE_APPROVAL === "1") {
        reject("approvalRequirementStale");
        break;
      }
      if (p.choiceId === "deny" && p.feedback !== "Declined by the user in T3 Code.") {
        reject("invalidParams", "missing feedback");
        break;
      }
      respond({
        commandId: p.commandId,
        approvalId: "approval",
        status: "accepted",
        terminal: true,
      });
      notify("approval/resolved", {
        approvalId: "approval",
        itemId: "tool",
        turnId,
        decision: p.choiceId === "deny" ? "denied" : "approved",
        policyResult: "allow",
        resolvedBy: "user",
        stageEvidence: [],
      });
      waiting = "";
      finish();
      break;
    }
    case "userInput/answer":
    case "userInput/cancel":
      respond({ commandId: p.commandId, userInputId: "input", status: "accepted" });
      notify("userInput/settled", {
        userInputId: "input",
        answers: p.answers ?? [],
        clarification: null,
        decidedByCommandId: p.commandId,
        outcome: frame.method === "userInput/answer" ? "answered" : "cancelled",
        reason: null,
      });
      waiting = "";
      finish();
      break;
    case "session/setModel": {
      const model = p.model as { modelId: string };
      modelId = model.modelId;
      respond({ commandId: p.commandId, status: "accepted" });
      break;
    }
    case "session/setApprovalMode":
    case "session/setReasoningEffort":
      respond({ commandId: p.commandId, status: "accepted" });
      break;
    default:
      reject("methodNotFound");
  }
}
