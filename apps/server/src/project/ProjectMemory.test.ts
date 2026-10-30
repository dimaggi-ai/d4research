import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ProjectMemorySaveInput, ThreadId, MessageId } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Memory from "./ProjectMemory.ts";

const projectId = ProjectId.make("memory-project");
const otherProjectId = ProjectId.make("other-memory-project");
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const id of [projectId, otherProjectId]) {
    yield* sql`INSERT OR IGNORE INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES (${id}, 'Memory test', '/test', '[]', '2026-09-08', '2026-09-08')`;
  }
});
describe("project memory", () => {
  it.effect("includes the index only on the first message even when another prompt is queued", () =>
    Effect.gen(function* () {
      yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("memory-thread");
      for (const [id, text] of [
        ["compact", " /compact\n"],
        ["first", "Hello"],
        ["second", "Queued follow-up"],
      ]) {
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at) VALUES (${id!}, ${threadId}, 'user', ${text!}, 0, '2026-09-08', '2026-09-08')`;
      }
      assert.include(
        yield* Memory.initialContext(projectId, threadId, MessageId.make("first")),
        "project_memory_read",
      );
      assert.equal(yield* Memory.initialContext(projectId, threadId, MessageId.make("second")), "");
      assert.include(
        yield* Memory.initialContext(projectId, threadId, MessageId.make("first"), true),
        "thread_workspace_create",
      );
      assert.include(
        yield* Memory.initialContext(projectId, threadId, MessageId.make("first"), true),
        "unlink_pull_request",
      );
      assert.notInclude(
        yield* Memory.initialContext(projectId, threadId, MessageId.make("first")),
        "thread_workspace_create",
      );
      assert.equal(
        yield* Memory.initialContext(projectId, threadId, MessageId.make("second"), true),
        "",
      );
      assert.equal(
        yield* Memory.initialContext(projectId, threadId, MessageId.make("compact"), true),
        "",
      );
      assert.equal(
        yield* Memory.initialContext(projectId, threadId, MessageId.make("compact")),
        "",
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
  it.effect("persists content, lists only descriptions, isolates projects, edits and deletes", () =>
    Effect.gen(function* () {
      yield* setup;
      const initial = {
        projectId,
        name: "hosts",
        description: "Read before deploying",
        content: "The host inventory is in the private console.",
      };
      yield* Memory.save(initial);
      const entries = yield* Memory.list(projectId);
      assert.equal(entries.length, 1);
      assert.isFalse("content" in entries[0]!);
      assert.deepEqual(yield* Memory.list(otherProjectId), []);
      assert.equal((yield* Memory.read(projectId, "hosts")).content, initial.content);
      assert.equal((yield* Effect.exit(Memory.read(otherProjectId, "hosts")))._tag, "Failure");
      yield* Memory.save({ ...initial, content: "Updated inventory location." });
      assert.equal((yield* Memory.read(projectId, "hosts")).content, "Updated inventory location.");
      yield* Memory.remove(otherProjectId, "hosts");
      assert.equal((yield* Memory.list(projectId)).length, 1);
      yield* Memory.remove(projectId, "hosts");
      assert.deepEqual(yield* Memory.list(projectId), []);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("makes a saved note available to another thread in the same project", () =>
    Effect.gen(function* () {
      yield* setup;
      const sql = yield* SqlClient.SqlClient;
      const firstThread = ThreadId.make("memory-thread-one");
      const secondThread = ThreadId.make("memory-thread-two");
      for (const threadId of [firstThread, secondThread]) {
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at) VALUES (${`${threadId}-message`}, ${threadId}, 'user', 'hello', 0, '2026-09-08', '2026-09-08')`;
      }
      yield* Memory.save({
        projectId,
        name: "deployment",
        description: "Read before deployment",
        content: "Deploy through the private release workflow.",
      });
      assert.include(
        yield* Memory.initialContext(
          projectId,
          firstThread,
          MessageId.make(`${firstThread}-message`),
        ),
        '"deployment"',
      );
      assert.include(
        yield* Memory.initialContext(
          projectId,
          secondThread,
          MessageId.make(`${secondThread}-message`),
        ),
        '"deployment"',
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it.effect("rejects missing and deleted projects and unknown threads", () =>
    Effect.gen(function* () {
      yield* setup;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_projects SET deleted_at = '2026-09-08' WHERE project_id = ${projectId}`;
      assert.equal((yield* Effect.exit(Memory.list(projectId)))._tag, "Failure");
      assert.equal(
        (yield* Effect.exit(
          Memory.save({ projectId, name: "hosts", description: "Hosts", content: "Unavailable" }),
        ))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.exit(Memory.projectForThread(ThreadId.make("unknown"))))._tag,
        "Failure",
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );

  it("validates names and bounds payload size", () => {
    const valid = {
      projectId,
      name: "hosts",
      description: "Read before deployment",
      content: "Host location",
    };
    const decode = Schema.decodeUnknownSync(ProjectMemorySaveInput);
    assert.deepEqual(decode(valid), valid);
    for (const invalid of [
      { ...valid, name: "../hosts" },
      { ...valid, description: " " },
      { ...valid, content: "x".repeat(16_001) },
    ])
      assert.throws(() => decode(invalid));
  });

  it("injects a discoverable index without full content", () => {
    const prompt = Memory.memoryInstructions([
      { name: "hosts", description: "Before deployment", content: "NOT-IN-THE-PROMPT" } as {
        name: string;
        description: string;
      },
    ]);
    assert.include(prompt, "project_memory_read");
    assert.include(prompt, "project_memory_save");
    assert.include(prompt, "Before deployment");
    assert.notInclude(prompt, "NOT-IN-THE-PROMPT");
    assert.include(Memory.memoryInstructions([]), "None yet.");
  });
});
