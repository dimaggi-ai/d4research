import { resolveInteractionMode } from "../mcp/delegatedTaskModes.ts";
import {
  OrchestratorMcpFailure,
  isProviderNativeSubagentThread,
  type PeerRelayReply,
  type PeerThreadOperation,
  type PeerThreadReply,
} from "@d4research/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { unavailable } from "../mcp/threadAccess.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";

export class PeerThreads extends Context.Service<
  PeerThreads,
  {
    readonly perform: (
      operation: PeerThreadOperation,
    ) => Effect.Effect<PeerRelayReply, OrchestratorMcpFailure>;
  }
>()("t3/peers/PeerThreads") {}

function terminal(status: string): status is PeerThreadReply["status"] {
  return ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(status);
}

const make = Effect.gen(function* () {
  const api = yield* OrchestratorMcpService.OrchestratorMcpService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const perform: PeerThreads["Service"]["perform"] = Effect.fn("PeerThreads.perform")(
    function* (operation) {
      const self = yield* environment.getDescriptor;
      if (operation.environmentId !== self.environmentId) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "This request reached a different environment.",
        });
      }
      const sender = operation.type === "thread-send" ? operation.input.sender : undefined;
      const namespace =
        sender === undefined ? "peer-reader" : `peer:${sender.environmentId}:${sender.threadId}`;
      // The authenticated relay owns access to this environment. The sending agent's modes
      // narrow that access further; its foreign thread id never impersonates a local caller.
      const scope: McpInvocationScope = {
        environmentId: self.environmentId,
        capabilities: new Set(["orchestration"]),
        issuedAt: 0,
        requestNamespace: namespace,
        thread: undefined,
        client: {
          sessionId: namespace,
          label: sender?.threadTitle ?? "Peer thread reader",
          access: sender?.runtimeMode ?? "read-only",
        },
      };
      switch (operation.type) {
        case "threads-list":
          return { type: "threads-listed", result: yield* api.listThreads(scope, operation.input) };
        case "thread-read": {
          const sequence = yield* threads
            .getThreadEventSequence(operation.input.threadId)
            .pipe(Effect.mapError(unavailable));
          return {
            type: "thread-read",
            result: { ...(yield* api.readThread(scope, operation.input)), sequence },
          };
        }
        case "thread-send": {
          const input = operation.input;
          const target = yield* threads
            .getThreadShell(input.threadId)
            .pipe(Effect.mapError(unavailable));
          if (target === null || target.deletedAt !== null)
            return yield* new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: "The destination thread was not found.",
            });
          if (isProviderNativeSubagentThread(target))
            return yield* new OrchestratorMcpFailure({
              code: "thread_not_sendable",
              message:
                "Use the provider's native SendMessage/send_input tool for this subagent, or message its parent. Its T3 transcript cannot accept ordinary turns.",
            });
          yield* resolveInteractionMode(input.sender.interactionMode, target.interactionMode);
          const header = `Agent message from ${input.sender.environmentLabel} / ${input.sender.threadTitle}\nSource environment: ${input.sender.environmentId}\nSource thread: ${input.sender.threadId}\n\n`;
          const result = yield* api
            .sendToThread(scope, { ...input, message: header + input.message })
            .pipe(
              Effect.provideService(DispatchModeLimit, {
                runtimeMode: input.sender.runtimeMode,
                interactionMode: input.sender.interactionMode,
              }),
            );
          if (result.afterSequence === undefined || !Number.isFinite(result.afterSequence))
            return yield* unavailable();
          return {
            type: "thread-sent",
            result: { ...result, afterSequence: result.afterSequence },
          };
        }
        case "thread-wait": {
          const input = operation.input;
          const shell = yield* threads
            .getThreadShell(input.threadId)
            .pipe(Effect.mapError(unavailable));
          if (shell === null || shell.deletedAt !== null)
            return yield* new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: "The watched thread was removed.",
            });
          const next = Stream.merge(
            threads.streamStoredEventsFrom({
              threadId: input.threadId,
              afterSequence: input.afterSequence,
              eventType: "run.updated",
            }),
            threads.streamStoredEventsFrom({
              threadId: input.threadId,
              afterSequence: input.afterSequence,
              eventType: "thread.deleted",
            }),
          ).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "thread.deleted" ||
                (stored.event.type === "run.updated" &&
                  terminal(stored.event.payload.status) &&
                  (input.runId === undefined || stored.event.payload.id === input.runId)),
            ),
            Stream.runHead,
            Effect.timeoutOption(input.timeoutMs),
            Effect.map(Option.flatten),
            Effect.mapError(unavailable),
          );
          const event = yield* next;
          if (Option.isNone(event)) return { type: "thread-waited", result: { reply: null } };
          const stored = event.value;
          if (stored.event.type !== "run.updated" || !terminal(stored.event.payload.status)) {
            return yield* new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: "The watched thread was removed.",
            });
          }
          const run = stored.event.payload;
          const records = yield* threads
            .getThreadRecords(input.threadId, ["messages"], {
              messageRoles: ["assistant"],
              messageRunIds: [run.id],
            })
            .pipe(Effect.mapError(unavailable));
          const text = records.messages.map((message) => message.text).join("\n\n");
          return {
            type: "thread-waited",
            result: {
              reply: {
                threadId: input.threadId,
                runId: run.id,
                status: run.status as PeerThreadReply["status"],
                sequence: stored.sequence,
                text: text.slice(0, 32_000),
                truncated: text.length > 32_000,
              },
            },
          };
        }
      }
    },
  );
  return PeerThreads.of({ perform });
});

export const layer = Layer.effect(PeerThreads, make);
