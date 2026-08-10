// @effect-diagnostics nodeBuiltinImport:off
/**
 * Replays recorded real-CLI message streams through the adapter.
 *
 * The hand-written fake in ClaudeAdapter.test.ts can only reproduce shapes we
 * already thought of — that is exactly how the `[ede_diagnostic]` stop bug
 * shipped. These fixtures are captured from the real CLI
 * (`scripts/record-claude-fixture.ts`), and the assertions here are
 * *invariants* rather than golden output, so a newly recorded stream with an
 * unfamiliar shape still fails loudly instead of silently passing.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProviderDriverKind } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import {
  ClaudeFixtureAdapter,
  THREAD_ID,
  listClaudeFixtures,
  loadClaudeFixture,
  makeFixtureHarness,
} from "./claudeFixtureHarness.ts";

const fixtureNames = listClaudeFixtures();

/** A recorded result message is the ground truth for what the turn should be. */
function expectedStateFor(messages: ReadonlyArray<SDKMessage>): "completed" | "failed" | null {
  const result = messages.find((message) => message.type === "result");
  if (!result) return null;
  const asResult = result as { subtype?: string; is_error?: boolean };
  if (asResult.subtype === "success") return "completed";
  // Only a genuine `is_error` result may surface as a failure. Anything else
  // is an interruption or a diagnostic, never a user-visible provider error.
  return asResult.is_error === true ? "failed" : null;
}

describe("ClaudeAdapter recorded fixtures", () => {
  it("has fixtures to replay", () => {
    assert.isAbove(
      fixtureNames.length,
      0,
      "no recorded fixtures found — record one with scripts/record-claude-fixture.ts",
    );
  });

  for (const name of fixtureNames) {
    it.effect(`replays ${name} without inventing a runtime error`, () => {
      const harness = makeFixtureHarness();
      const messages = loadClaudeFixture(name);
      return Effect.gen(function* () {
        const adapter = yield* ClaudeFixtureAdapter;

        const runtimeEventsFiber = yield* Stream.takeUntil(
          adapter.streamEvents,
          (event) => event.type === "turn.completed",
        ).pipe(Stream.runCollect, Effect.forkChild);

        const session = yield* adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("claudeAgent"),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId: session.threadId,
          input: "replayed fixture",
          attachments: [],
        });

        for (const message of messages) {
          harness.query.emit(message);
        }

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        const turnCompleted = runtimeEvents.find((event) => event.type === "turn.completed");
        const runtimeError = runtimeEvents.find((event) => event.type === "runtime.error");

        // Invariant 1: every recorded stream must terminate the turn. A stream
        // that leaves the turn hanging is the "spinner that never stops" bug.
        assert.isDefined(turnCompleted, `${name}: turn never completed`);

        const expectedState = expectedStateFor(messages);

        // Invariant 2: only a genuine is_error result may produce a failure or
        // a user-visible runtime error.
        if (expectedState !== "failed") {
          assert.isUndefined(
            runtimeError,
            `${name}: surfaced a runtime error for a non-error result`,
          );
          if (turnCompleted?.type === "turn.completed") {
            assert.notEqual(
              turnCompleted.payload.state,
              "failed",
              `${name}: reported failure for a non-error result`,
            );
          }
        }

        // Invariant 3: internal CLI diagnostics must never reach the user.
        const surfaced = [
          runtimeError?.type === "runtime.error" ? runtimeError.payload.message : "",
          turnCompleted?.type === "turn.completed"
            ? (turnCompleted.payload.errorMessage ?? "")
            : "",
        ].join(" ");
        assert.notInclude(
          surfaced.toLowerCase(),
          "[ede_diagnostic]",
          `${name}: leaked an internal CLI diagnostic to the user`,
        );
      }).pipe(Effect.provide(harness.layer));
    });
  }
});
