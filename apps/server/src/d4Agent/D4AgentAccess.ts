import type { ThreadId } from "@d4research/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./D4AgentStore.ts";

// Transport identity is an Effect context value, never a client command field.
export const DispatchOrigin = Context.Reference<
  "authenticated-user" | "internal-heartbeat" | undefined
>("d4research/d4Agent/DispatchOrigin", { defaultValue: () => undefined });

// Store ownership is available below the monitor/context layer without a cycle.
export const ownership = Effect.gen(function* () {
  const store = yield* Effect.serviceOption(Store.D4AgentStore);
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  return (threadId: ThreadId) =>
    Effect.gen(function* () {
      if (Option.isNone(store)) return false;
      if ((yield* store.value.get).threadId === threadId) return true;
      if (Option.isNone(sql)) return false;
      // A quarantined state file must not expose the old aggregate conversation.
      const matches = yield* sql.value<{ owned: number }>`
      SELECT 1 AS owned FROM orchestration_v2_projection_threads AS threads
      JOIN projection_projects AS projects ON projects.project_id = threads.project_id
      WHERE threads.thread_id = ${threadId} AND projects.workspace_root = ${store.value.workspace}
      LIMIT 1
    `.pipe(Effect.catch(() => Effect.succeed([{ owned: 1 }])));
      return matches.length > 0;
    });
});
