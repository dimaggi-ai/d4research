import { useParams } from "@tanstack/react-router";
import { useMemo } from "react";
import { type ThreadRouteTarget, resolveThreadRouteTarget } from "../threadRoutes";

/**
 * Resolves the thread target of the current route with a stable identity.
 *
 * Selecting the derived target straight from useParams hands consumers a
 * fresh object on every router store update, and even a selected params
 * slice comes back as a new object per render. Effects that depend on that
 * target then re-fire on every commit: the missing-thread redirect in
 * ThreadRouteView called navigate("/") in a loop, each call restarting the
 * pending load, and the page never finished the transition. Memoizing on the
 * primitive params keeps the target stable until the route actually changes.
 */
export function useThreadRouteTarget(): ThreadRouteTarget | null {
  const { environmentId, threadId, draftId } = useParams({
    strict: false,
    select: (routeParams) => ({
      environmentId: routeParams.environmentId,
      threadId: routeParams.threadId,
      draftId: routeParams.draftId,
    }),
  });
  return useMemo(
    () => resolveThreadRouteTarget({ environmentId, threadId, draftId }),
    [environmentId, threadId, draftId],
  );
}
