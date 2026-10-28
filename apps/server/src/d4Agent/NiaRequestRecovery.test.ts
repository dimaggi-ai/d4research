import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@d4research/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { recover, recoveryCommand } from "./NiaRequestRecovery.ts";

type MutableProjection = {
  -readonly [K in keyof OrchestrationV2ThreadProjection]: OrchestrationV2ThreadProjection[K];
};
const fixture = () =>
  ({
    thread: {
      id: ThreadId.make("nia"),
      providerInstanceId: "provider",
      archivedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: RunId.make("original"),
        userMessageId: MessageId.make("request"),
        status: "cancelled",
        providerInstanceId: "provider",
        modelSelection: { provider: "codex", model: "test" },
        startedAt: DateTime.makeUnsafe(0),
        completedAt: DateTime.makeUnsafe(0),
      },
    ],
    messages: [],
    runtimeRequests: [],
    turnItems: [],
    providerTurns: [],
  }) as unknown as MutableProjection;

it("recovers a restart-cancelled request in the same thread without duplicating its user message", () => {
  const command = recoveryCommand(fixture(), "request", 15_000);
  assert.equal(command?.threadId, "nia");
  assert.equal(command?.messageId, "message:nia-recovery:original");
  assert.equal(command?.restartContinuationOfRunId, "original");
  assert.equal(command?.createdBy, "agent");
  assert.equal(command?.commandId, "command:nia-recovery:original");
});
it.each(["completed", "interrupted", "running", "queued", "waiting", "starting", "preparing"])(
  "does not recover a %s request",
  (status) => {
    const p = fixture();
    p.runs = [{ ...p.runs[0]!, status } as (typeof p.runs)[number]];
    assert.isUndefined(recoveryCommand(p, "request", 60_000));
  },
);
it("honors explicit stop, pending input, closed sessions and provider changes", () => {
  for (const mutate of [
    (p: MutableProjection) => {
      p.turnItems = [
        { type: "run_interrupt_request", runId: RunId.make("original") },
      ] as unknown as typeof p.turnItems;
    },
    (p: MutableProjection) => {
      p.turnItems = [
        { type: "secret_request", runId: RunId.make("original") },
      ] as unknown as typeof p.turnItems;
    },
    (p: MutableProjection) => {
      p.runtimeRequests = [{ status: "pending" }] as unknown as typeof p.runtimeRequests;
    },
    (p: MutableProjection) => {
      p.thread = { ...p.thread, archivedAt: DateTime.makeUnsafe(1) };
    },
    (p: MutableProjection) => {
      p.thread = { ...p.thread, settledOverride: "settled" };
    },
    (p: MutableProjection) => {
      p.thread = { ...p.thread, snoozedUntil: DateTime.makeUnsafe(90_000) };
    },
    (p: MutableProjection) => {
      p.thread = { ...p.thread, providerInstanceId: "other" as typeof p.thread.providerInstanceId };
    },
  ]) {
    const p = fixture();
    mutate(p);
    assert.isUndefined(recoveryCommand(p, "request", 60_000));
  }
});
it("retries transient failures but not auth, quota, validation or explicit non-retryable errors", () => {
  for (const [kind, retryable, expected] of [
    ["transport_error", null, true],
    ["provider_error", true, true],
    ["provider_error", false, false],
    ["permission_error", true, false],
    ["usage_limit", true, false],
    ["validation_error", true, false],
    ["unknown", null, false],
  ] as const) {
    const p = fixture();
    p.runs = [{ ...p.runs[0]!, status: "failed" }];
    p.turnItems = [
      { type: "error", runId: RunId.make("original"), failure: { class: kind, retryable } },
    ] as unknown as typeof p.turnItems;
    assert.equal(recoveryCommand(p, "request", 60_000) !== undefined, expected);
  }
});
it("backs off and stops after three durable continuations, including across restarts", () => {
  const p = fixture();
  assert.isUndefined(recoveryCommand(p, "request", 14_999));
  for (let n = 1; n <= 3; n++) {
    const prior = p.runs.at(-1)!;
    p.runs = [
      ...p.runs,
      {
        ...prior,
        id: RunId.make(`retry-${n}`),
        userMessageId: MessageId.make(`continuation-${n}`),
        restartContinuationOfRunId: prior.id,
      },
    ];
    assert.isUndefined(recoveryCommand(p, "request", 15_000 * 2 ** n - 1));
    assert.equal(recoveryCommand(p, "request", 15_000 * 2 ** n) !== undefined, n < 3);
  }
});
it("does not retry a completed continuation or a different user request", () => {
  const p = fixture();
  p.runs = [
    ...p.runs,
    {
      ...p.runs[0]!,
      id: RunId.make("done"),
      userMessageId: MessageId.make("continuation"),
      status: "completed",
      restartContinuationOfRunId: p.runs[0]!.id,
    },
  ];
  assert.isUndefined(recoveryCommand(p, "request", 60_000));
  assert.isUndefined(recoveryCommand(fixture(), "newer-request", 60_000));
});
it.effect(
  "uncertain dispatch retries use one durable command receipt and stop after the message exists",
  () =>
    Effect.gen(function* () {
      let p = fixture();
      const receipts = new Set<CommandId>();
      let dispatches = 0;
      const layer = Layer.mock(Threads.ThreadManagementService)({
        getThreadRecords: () => Effect.sync(() => p),
        dispatch: (command) =>
          Effect.gen(function* () {
            dispatches++;
            receipts.add(command.commandId);
            if (dispatches === 1) return yield* Effect.fail(new Error("response lost") as never);
            if (command.type === "message.dispatch")
              p = { ...p, messages: [{ id: command.messageId }] as unknown as typeof p.messages };
            return {} as never;
          }),
      });
      yield* TestClock.adjust("1 minute");
      const action = recover(ThreadId.make("nia"), "request").pipe(Effect.provide(layer));
      yield* Effect.result(action);
      yield* action;
      yield* action;
      assert.equal(dispatches, 2);
      assert.equal(receipts.size, 1);
    }),
);

it("does not repeat a provider reply completed before a checkpoint or shutdown failure", () => {
  const p = fixture();
  p.providerTurns = [
    { runAttemptId: p.runs[0]!.activeAttemptId, status: "completed" },
  ] as unknown as typeof p.providerTurns;
  assert.isUndefined(recoveryCommand(p, "request", 60_000));
});

it("does not revive a user-deleted queued request", () => {
  const p = fixture();
  p.runs = [{ ...p.runs[0]!, startedAt: null }];
  assert.isUndefined(recoveryCommand(p, "request", 60_000));
});
