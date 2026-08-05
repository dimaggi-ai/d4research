import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export interface QueuedChatRequest {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
}

interface RequestQueueStoreState {
  readonly byThreadKey: Record<string, ReadonlyArray<QueuedChatRequest>>;
  enqueue: (threadKey: string, request: QueuedChatRequest) => void;
  remove: (threadKey: string, requestId: string) => void;
}

export function appendQueuedRequest(
  current: Record<string, ReadonlyArray<QueuedChatRequest>>,
  threadKey: string,
  request: QueuedChatRequest,
): Record<string, ReadonlyArray<QueuedChatRequest>> {
  return { ...current, [threadKey]: [...(current[threadKey] ?? []), request] };
}

export function removeQueuedRequest(
  current: Record<string, ReadonlyArray<QueuedChatRequest>>,
  threadKey: string,
  requestId: string,
): Record<string, ReadonlyArray<QueuedChatRequest>> {
  const queue = current[threadKey];
  if (!queue?.some((request) => request.id === requestId)) return current;
  const nextQueue = queue.filter((request) => request.id !== requestId);
  if (nextQueue.length > 0) return { ...current, [threadKey]: nextQueue };
  const { [threadKey]: _removed, ...rest } = current;
  return rest;
}

export function canAutoDispatchQueuedRequest(input: {
  readonly request: QueuedChatRequest | undefined;
  readonly running: boolean;
  readonly blocked: boolean;
  readonly failedRequestId: string | null;
}): input is typeof input & { readonly request: QueuedChatRequest } {
  return (
    input.request !== undefined &&
    !input.running &&
    !input.blocked &&
    input.failedRequestId !== input.request.id
  );
}

export const useRequestQueueStore = create<RequestQueueStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      enqueue: (threadKey, request) =>
        set((state) => ({
          byThreadKey: appendQueuedRequest(state.byThreadKey, threadKey, request),
        })),
      remove: (threadKey, requestId) =>
        set((state) => ({
          byThreadKey: removeQueuedRequest(state.byThreadKey, threadKey, requestId),
        })),
    }),
    {
      name: "t3code:request-queue:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThreadKey: state.byThreadKey }),
    },
  ),
);
