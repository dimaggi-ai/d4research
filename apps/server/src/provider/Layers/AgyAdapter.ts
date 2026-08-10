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
import type * as Duration from "effect/Duration";
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
import { toolGuardEnvironment } from "../toolGuardRuntime.ts";
import { decodeAgyStreamLine } from "./AgyStream.ts";

const PROVIDER = ProviderDriverKind.make("agy");
const RESUME_VERSION = 1 as const;
export const AGY_PROMPT_MAX_CHARS = 96_000;

export interface PreparedAgyPrompt {
  readonly text: string;
  readonly omittedChars: number;
}

/**
 * Agy accepts oversized stdin but its hosted runner silently cuts the tail and
 * still reports SUCCESS. Preserve both the context preamble and the final task
 * inside a conservative ceiling, with an explicit omission marker so neither
 * the model nor the caller mistakes a partial prompt for the full input.
 */
export function prepareAgyPrompt(input: string): PreparedAgyPrompt {
  if (input.length <= AGY_PROMPT_MAX_CHARS) return { text: input, omittedChars: 0 };
  let marker = `\n\n[... ${input.length - AGY_PROMPT_MAX_CHARS} characters omitted to fit Agy's prompt limit ...]\n\n`;
  for (let pass = 0; pass < 10; pass += 1) {
    const available = AGY_PROMPT_MAX_CHARS - marker.length;
    const headLength = Math.floor(available * 0.4);
    const tailLength = available - headLength;
    const omittedChars = input.length - headLength - tailLength;
    const nextMarker = `\n\n[... ${omittedChars} characters omitted to fit Agy's prompt limit ...]\n\n`;
    if (nextMarker === marker) break;
    marker = nextMarker;
  }
  const available = AGY_PROMPT_MAX_CHARS - marker.length;
  const headLength = Math.floor(available * 0.4);
  const tailLength = available - headLength;
  const omittedChars = input.length - headLength - tailLength;
  return {
    text: `${input.slice(0, headLength)}${marker}${input.slice(input.length - tailLength)}`,
    omittedChars,
  };
}

/**
 * Distinguishes adapter instances within one process. Paired with the wall
 * clock it makes ids unique both across server restarts (clock moves) and
 * between adapters built in the same millisecond (counter moves) — the latter
 * being every test run, where the clock is frozen at 0.
 */
let adapterInstanceSequence = 0;

interface AgyContext {
  session: ProviderSession;
  conversationId: string | undefined;
  process: ChildProcessSpawner.ChildProcessHandle | undefined;
  turnReserved: boolean;
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
  /**
   * Hard server-side ceiling for one turn. Overridable so tests can exercise
   * the timeout path without waiting the production duration.
   */
  readonly turnTimeout?: Duration.Input;
}

// A hard net for agy wedging on its pipe, not a limit on real work: kept well
// above legitimate drafting time and below the research delegate's own ceiling.
const DEFAULT_TURN_TIMEOUT: Duration.Input = "20 minutes";

export const makeAgyAdapter = (settings: AgySettings, options?: AgyAdapterLiveOptions) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const instanceId = options?.instanceId ?? ProviderInstanceId.make("agy");
    const sessions = new Map<ThreadId, AgyContext>();
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    // Event/turn ids must never repeat across server restarts: the projector
    // keys persisted rows by these ids, and a bare counter restarting at zero
    // made new turns append into message rows from long-dead conversations.
    adapterInstanceSequence += 1;
    const bootStamp = [
      String(instanceId),
      DateTime.toEpochMillis(yield* DateTime.now).toString(36),
      adapterInstanceSequence.toString(36),
    ].join("-");
    let eventSequence = 0;

    const stamp = Effect.gen(function* () {
      eventSequence += 1;
      return {
        eventId: EventId.make(`agy-${bootStamp}-${eventSequence}`),
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
          turnReserved: false,
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
          payload: { state: "ready", reason: "Agy print session ready" },
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

    const sendTurn: AgyAdapterShape["sendTurn"] = (input) => {
      // Assigned once the turn owns a child process. Without this, a turn that
      // times out or whose stream fiber fails never reaches the normal
      // teardown: the process leaks and `context.process` stays set, so every
      // later turn is rejected with "already has a turn in progress" and the
      // session is wedged for good.
      let releaseTurn: Effect.Effect<void> | undefined;
      // The normal path finalizes the turn itself (even on a failed result),
      // and `onError` would otherwise run releaseTurn again and emit a second
      // turn.completed. This flag makes finalization happen exactly once.
      let turnSettled = false;
      let reservedContext: AgyContext | undefined;
      return Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        if (context.turnReserved || context.process !== undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: "Agy already has a turn in progress for this thread.",
          });
        }
        const rawText = input.input?.trim();
        if (!rawText) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Agy currently requires non-empty text input.",
          });
        }
        // Reserve synchronously before the next yield. The process handle is
        // assigned only after command resolution and spawn, which otherwise
        // lets two concurrent fibers both start a turn on the same thread.
        context.turnReserved = true;
        reservedContext = context;
        const turnId = TurnId.make(`agy-turn-${bootStamp}-${eventSequence + 1}`);
        const preparedPrompt = prepareAgyPrompt(rawText);
        const text = preparedPrompt.text;
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
        if (preparedPrompt.omittedChars > 0) {
          yield* offer({
            type: "runtime.warning",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: {
              message: "Agy prompt shortened before dispatch.",
              detail: {
                originalChars: rawText.length,
                sentChars: text.length,
                omittedChars: preparedPrompt.omittedChars,
              },
            },
          });
        }

        // The prompt goes on stdin, never argv. A research delegate carries
        // shared memory context and routinely exceeds Linux's 128KB
        // MAX_ARG_STRLEN, where an argv prompt dies with E2BIG before agy
        // starts — which is why agy was the only provider failing every
        // delegated draft. `agy` with no --print value reads stdin.
        const args = [
          ...tokenizeCliArgs(settings.launchArgs),
          "--output-format",
          "stream-json",
          "--print-timeout",
          "5m",
          "--model",
          model,
          ...(context.conversationId
            ? ["--conversation", context.conversationId]
            : ["--new-project"]),
          ...(context.session.runtimeMode === "full-access"
            ? ["--dangerously-skip-permissions"]
            : ["--sandbox"]),
        ];
        let responseText = "";
        let resultStatus: string | undefined;
        const stderrRef = yield* Ref.make("");
        const turnScope = yield* Scope.make();
        releaseTurn = Effect.gen(function* () {
          if (turnSettled) return;
          turnSettled = true;
          if (context.process) yield* context.process.kill().pipe(Effect.ignore);
          context.process = undefined;
          context.turnReserved = false;
          yield* Scope.close(turnScope, Exit.void).pipe(Effect.ignore);
          const { activeTurnId: _abandonedTurnId, ...sessionWithoutTurn } = context.session;
          context.session = {
            ...sessionWithoutTurn,
            status: "ready",
            updatedAt: yield* nowIso,
          };
          // Every turn.started must be answered by a turn.completed, including
          // failures while resolving or spawning the CLI itself.
          yield* offer({
            type: "turn.completed",
            ...(yield* stamp),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: context.interrupted
              ? { state: "cancelled", stopReason: "cancelled" }
              : { state: "failed", errorMessage: "Agy turn ended without a result." },
          });
        });
        const environment = toolGuardEnvironment(
          options?.environment ?? process.env,
          context.session.runtimeMode,
        );
        const resolved = yield* resolveSpawnCommand(settings.binaryPath || "agy", args, {
          env: environment,
        });
        const handle = yield* spawner
          .spawn(
            ChildProcess.make(resolved.command, resolved.args, {
              cwd: context.session.cwd,
              env: environment,
              shell: resolved.shell,
              stdin: Stream.succeed(new TextEncoder().encode(text)),
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
            const finalResponse = event.result.response;
            if (finalResponse !== undefined) {
              // Some Agy models emit no agent_response step at all and return
              // their entire answer only in the terminal result. Without a
              // delta the durable transcript was correct after reload while
              // the live client rendered an empty assistant turn. A final
              // response that extends streamed text can likewise carry a
              // suffix the client has not seen yet.
              const missingDelta = finalResponse.startsWith(responseText)
                ? finalResponse.slice(responseText.length)
                : responseText.length === 0
                  ? finalResponse
                  : "";
              if (missingDelta) {
                yield* offer({
                  type: "content.delta",
                  ...(yield* stamp),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: { streamKind: "assistant_text", delta: missingDelta },
                });
              }
              responseText = finalResponse;
            }
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
          yield* Effect.gen(function* () {
            const code = yield* handle.exitCode.pipe(
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
            // A child/grandchild can keep inherited stdout or stderr open
            // after the Agy parent exits. Draining both pipes is therefore part
            // of the same bounded process lifecycle, not unbounded cleanup.
            yield* Fiber.join(outputFiber);
            yield* Fiber.join(stderrFiber);
            return code;
          }).pipe(
            // `--print-timeout 5m` is only a hint to the CLI; agy is known to
            // wedge on either process exit or inherited pipes, so enforce one
            // hard server-side deadline around both exit and stream drains.
            Effect.timeoutOrElse({
              duration: options?.turnTimeout ?? DEFAULT_TURN_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "agy --print",
                    detail: "Agy turn exceeded its server-side deadline; killing the process.",
                  }),
                ),
            }),
          ),
        );
        const stderr = yield* Ref.get(stderrRef);
        yield* Scope.close(turnScope, Exit.void);
        context.process = undefined;
        context.turnReserved = false;
        const interrupted = context.interrupted;
        const emptySuccess = exitCode === 0 && resultStatus === "SUCCESS" && !responseText.trim();
        const succeeded = exitCode === 0 && resultStatus === "SUCCESS" && !emptySuccess;
        const failureDetail = emptySuccess
          ? "Agy returned SUCCESS without assistant output."
          : stderr.trim() || `Agy exited with code ${exitCode}.`;
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
        // The normal path owns finalization from here; releaseTurn (via
        // onError, when this then fails) must not emit a second completion.
        turnSettled = true;
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
                  errorMessage: failureDetail,
                },
        });
        if (!interrupted && !succeeded) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "agy --print",
            detail: failureDetail,
          });
        }
        return {
          threadId: input.threadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        };
      }).pipe(
        Effect.onError(() => releaseTurn ?? Effect.void),
        Effect.ensuring(
          Effect.sync(() => {
            if (reservedContext) reservedContext.turnReserved = false;
          }),
        ),
      );
    };

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
        detail: "Agy print mode does not expose interactive request callbacks.",
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
