import { useEffect, useRef } from "react";
import {
  parseScopedThreadKey,
  scopeThreadRef,
  scopedThreadKey,
} from "@d4research/client-runtime/environment";
import { effectiveSnoozed } from "@d4research/client-runtime/state/thread-settled";
import {
  planLegacySidebarOrderMigration,
  useSidebarThreadOrderStore,
} from "../sidebarThreadOrderStore";
import {
  readThreadShell,
  useAllEnvironmentShellsBootstrapped,
  useAllEnvironmentProjectSnapshotsReady,
  useServerConfigs,
  useThreadShells,
} from "../state/entities";
import type { useThreadActions } from "./useThreadActions";
import { toastManager } from "../components/ui/toast";

export function useSidebarOrderMigration(
  reorderActiveThread: ReturnType<typeof useThreadActions>["reorderActiveThread"],
) {
  const threads = useThreadShells();
  const configs = useServerConfigs();
  const ready = useAllEnvironmentShellsBootstrapped();
  const liveSnapshotsReady = useAllEnvironmentProjectSnapshotsReady();
  const attempted = useRef(false);
  useEffect(() => {
    if (!ready || !liveSnapshotsReady || attempted.current) return;
    const store = useSidebarThreadOrderStore.getState();
    if (store.migrating) return;
    if (store.order.length === 0 && store.pendingMigration.length === 0) return;
    const now = new Date().toISOString();
    const eligible = threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.pinnedAt == null &&
        thread.settledOverride !== "settled" &&
        !effectiveSnoozed(thread, { now }) &&
        configs.get(thread.environmentId)?.environment.capabilities.threadActiveReorder === true,
    );
    const plan = planLegacySidebarOrderMigration({
      items: eligible.map((thread) => ({
        id: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        activeOrderKey: thread.activeOrderKey ?? null,
      })),
      order: store.order,
      reservedKeys: new Set(
        threads.flatMap((thread) => (thread.activeOrderKey == null ? [] : [thread.activeOrderKey])),
      ),
    });
    const writes = store.pendingMigration.length > 0 ? store.pendingMigration : plan.writes;
    if (writes.length === 0) {
      if (plan.ids.size > 0) store.finishMigration(plan.ids);
      return;
    }
    // Persist the plan before the first write so an interrupted migration resumes
    // the same keys instead of treating its own partial result as a remote order.
    store.setPendingMigration(writes);
    attempted.current = true;
    store.setMigrating(true);
    void (async () => {
      try {
        for (const write of writes) {
          const ref = parseScopedThreadKey(write.id);
          if (!ref) continue;
          const shell = readThreadShell(ref);
          if (
            !shell ||
            shell.archivedAt !== null ||
            shell.pinnedAt != null ||
            shell.settledOverride === "settled" ||
            effectiveSnoozed(shell, { now: new Date().toISOString() })
          )
            continue;
          if (shell.activeOrderKey === write.orderKey) continue;
          if (shell.activeOrderKey != null) continue; // A later arrangement on another client wins.
          const result = await reorderActiveThread(ref, write.orderKey);
          if (result._tag !== "Success") throw new Error("Could not sync the saved thread order.");
        }
        store.finishMigration(new Set(writes.map((write) => write.id)));
      } catch {
        toastManager.add({
          type: "error",
          title: "Could not sync saved thread order",
          description: "Your saved order is retained. Reopen the sidebar to retry.",
        });
      } finally {
        store.setMigrating(false);
      }
    })();
  }, [configs, liveSnapshotsReady, ready, reorderActiveThread, threads]);
}
