import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  type AgySettings,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { AgyAdapterShape } from "../Services/AgyAdapter.ts";
import { decodeAgyStreamLine } from "./AgyStream.ts";

const PROVIDER = ProviderDriverKind.make("agy");
const RESUME_VERSION = 1 as const;

interface AgyContext {
  session: ProviderSession;
  conversationId: string | undefined;
  process: ChildProcessSpawner.ChildProcessHandle | undefined;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  interrupted: boolean;
}

function parseResumeCursor(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const cursor = value as { schemaVersion?: unknown; conversationId?: unknown };
  return cursor.schemaVersion === RESUME_VERSION && typeof cursor.conversationId === "string"
    ? cursor.conversationId.trim() || undefined
    : undefined;
}

export interface AgyAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

export const makeAgyAdapter = (settings: AgySettings, options?: AgyAdapterLiveOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const instanceId = options?.instanceId ?? ProviderInstanceId.make("agy");
    const sessions = new Map<ThreadId, AgyContext>();
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    let eventSequence = 0;

    const stamp = Effect.gen(function* () {
      eventSequence += 1;
      return {
        eventId: EventId.make(`agy-${eventSequence}`),
        createdAt: yield* nowIso,
      };
    });
    const offer = (event: ProviderRuntimeEvent) =>
      PubSub.publish(events, event).pipe(Effect.asVoid);
    const requireSession = (threadId: ThreadId) => {
      const context = sessions.get(threadId);
      return context
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const startSession: AgyAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        const cwd = input.cwd?.trim();
        if (!cwd) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing?.process) yield* existing.process.kill().pipe(Effect.ignore);
        const conversationId = parseResumeCursor(input.resumeCursor);
        const model =
          input.modelSelection?.instanceId === instanceId
            ? input.modelSelection.model
            : settings.defaultModel;
        const timestamp = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          threadId: input.threadId,
          cwd,
          runtimeMode: input.runtimeMode,
          status: "ready",
          model,
          ...(conversationId
            ? { resumeCursor: { schemaVersion: RESUME_VERSION, conversationId } }
            : {}),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        sessions.set(input.threadId, {
          session,
          conversationId,
          process: undefined,
          turns: [],
          interrupted: false,
        });
        yield* offer({
          type: "session.started",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { resume: conversationId ?? null },
        });
        yield* offer({
          type: "session.state.changed",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { state: "ready", reason: "Antigravity print session ready" },
        });
        yield* offer({
          type: "thread.started",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: conversationId ?? String(input.threadId) },
        });
        return session;
      });

    const sendTurn: AgyAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        if (context.process !== undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: "Antigravity already has a turn in progress for this thread.",
          });
        }
        const text = input.input?.trim();
        if (!text) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Antigravity currently requires non-empty text input.",
          });
        }
        const turnId = TurnId.make(`agy-turn-${eventSequence + 1}`);
        const model =
          input.modelSelection?.instanceId === instanceId
            ? input.modelSelection.model
            : (context.session.model ?? settings.defaultModel);
        context.interrupted = false;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          model,
          updatedAt: yield* nowIso,
        };
        yield* offer({
          type: "turn.started",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model },
        });

        const args = [
          ...tokenizeCliArgs(settings.launchArgs),
          "--print",
          text,
          "--output-format",
          "stream-json",
          "--print-timeout",
          "5m",
          "--model",
          model,
          ...(context.conversationId ? ["--conversation", context.conversationId] : []),
          ...(context.session.runtimeMode === "full-access"
            ? ["--dangerously-skip-permissions"]
            : ["--sandbox"]),
        ];
        let responseText = "";
        let resultStatus: string | undefined;
        const stderrRef = yield* Ref.make("");
        const turnScope = yield* Scope.make();
        const resolved = yield* resolveSpawnCommand(settings.binaryPath || "agy", args, {
          env: options?.environment ?? process.env,
        });
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(resolved.command, resolved.args, {
              cwd: context.session.cwd,
              env: options?.environment ?? process.env,
              shell: resolved.shell,
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, turnScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "agy --print",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
        context.process = handle;
        const processLine = Effect.fn("AgyAdapter.processLine")(function* (line: string) {
          const event = decodeAgyStreamLine(line.trim());
          if (!event) return;
          if (event.event === "init") {
            context.conversationId = event.conversation_id;
            return;
          }
          if (event.event === "result") {
            context.conversationId = event.result.conversation_id;
            resultStatus = event.result.status;
            responseText = event.result.response ?? responseText;
            return;
          }
          const update = event.step_update;
          if (update.step_type !== "agent_response" || !update.text_delta) return;
          responseText += update.text_delta;
          yield* offer({
            type: "content.delta",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: { streamKind: "assistant_text", delta: update.text_delta },
          });
        });
        const outputFiber = yield* handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach(processLine),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "agy stdout",
                detail: cause.message,
                cause,
              }),
          ),
          Effect.forkIn(turnScope),
        );
        const stderrFiber = yield* handle.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Ref.update(stderrRef, (current) => `${current}${chunk}`.slice(-8_000)),
          ),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "agy stderr",
                detail: cause.message,
                cause,
              }),
          ),
          Effect.forkIn(turnScope),
        );
        const exitCode = Number(
          yield* handle.exitCode.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "agy --print",
                  detail: cause.message,
                  cause,
                }),
            ),
          ),
        );
        yield* Fiber.join(outputFiber);
        yield* Fiber.join(stderrFiber);
        const stderr = yield* Ref.get(stderrRef);
        yield* Scope.close(turnScope, Exit.void);
        context.process = undefined;
        const interrupted = context.interrupted;
        const succeeded = exitCode === 0 && resultStatus === "SUCCESS";
        const completedAt = yield* nowIso;
        const { activeTurnId: _activeTurnId, ...sessionWithoutTurn } = context.session;
        context.session = {
          ...sessionWithoutTurn,
          status: "ready",
          updatedAt: completedAt,
          ...(context.conversationId
            ? {
                resumeCursor: {
                  schemaVersion: RESUME_VERSION,
                  conversationId: context.conversationId,
                },
              }
            : {}),
        };
        context.turns.push({ id: turnId, items: responseText ? [{ text: responseText }] : [] });
        yield* offer({
          type: "turn.completed",
          ...(yield* stamp),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: interrupted
            ? { state: "cancelled", stopReason: "cancelled" }
            : succeeded
              ? { state: "completed", stopReason: "end_turn" }
              : {
                  state: "failed",
                  errorMessage: stderr.trim() || `Antigravity exited with code ${exitCode}.`,
                },
        });
        if (!interrupted && !succeeded) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "agy --print",
            detail: stderr.trim() || `Antigravity exited with code ${exitCode}.`,
          });
        }
        return {
          threadId: input.threadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: AgyAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        context.interrupted = true;
        if (context.process) yield* context.process.kill().pipe(Effect.ignore);
      });
    const unsupported = Effect.fn("AgyAdapter.unsupported")(function* (
      threadId: ThreadId,
      method: string,
    ) {
      yield* requireSession(threadId);
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: "Antigravity print mode does not expose interactive request callbacks.",
      });
    });
    const stopSession: AgyAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        context.interrupted = true;
        if (context.process) yield* context.process.kill().pipe(Effect.ignore);
        sessions.delete(threadId);
      });
    const stopAll = () =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          sessions.values(),
          (context) => context.process?.kill().pipe(Effect.ignore) ?? Effect.void,
          { discard: true },
        );
        sessions.clear();
      });
    yield* Effect.addFinalizer(() => stopAll());

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: (threadId) => unsupported(threadId, "respondToRequest"),
      respondToUserInput: (threadId) => unsupported(threadId, "respondToUserInput"),
      stopSession,
      listSessions: () => Effect.sync(() => [...sessions.values()].map((entry) => entry.session)),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread: (threadId) =>
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          return { threadId, turns: context.turns };
        }),
      rollbackThread: (threadId) => unsupported(threadId, "rollbackThread"),
      stopAll,
      streamEvents: Stream.fromPubSub(events),
    } satisfies AgyAdapterShape;
  });
