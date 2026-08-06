import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionThreadResumeScheduleRepository } from "../Services/ProjectionThreadResumeSchedule.ts";
import { ProjectionThreadResumeScheduleRepositoryLive } from "./ProjectionThreadResumeSchedule.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadResumeScheduleRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadResumeScheduleRepository", (it) => {
  it.effect("upserts, lists due rows, gets, and deletes by thread", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadResumeScheduleRepository;
      const threadId = ThreadId.make("thread-resume");
      const row = {
        threadId,
        resumeAt: "2026-08-05T10:10:00.000Z",
        reason: "Rate limit reached",
        provider: "codex",
        instanceId: ProviderInstanceId.make("codex-work"),
        model: "gpt-5.6-sol",
        prompt: "Continue the previous task.",
        createdAt: "2026-08-05T10:00:00.000Z",
        attempts: 0,
      } as const;

      yield* repository.upsert(row);
      assert.isTrue(Option.isSome(yield* repository.getByThreadId({ threadId })));
      assert.deepEqual(yield* repository.listDue({ now: "2026-08-05T10:09:59.999Z" }), []);
      assert.deepEqual(yield* repository.listDue({ now: row.resumeAt }), [row]);

      yield* repository.upsert({ ...row, attempts: 2, reason: "Updated limit" });
      assert.deepEqual(Option.getOrThrow(yield* repository.getByThreadId({ threadId })), {
        ...row,
        attempts: 2,
        reason: "Updated limit",
      });

      yield* repository.deleteByThreadId({ threadId });
      assert.isTrue(Option.isNone(yield* repository.getByThreadId({ threadId })));
    }),
  );
});
