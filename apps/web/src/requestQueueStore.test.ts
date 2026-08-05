import { describe, expect, it } from "vite-plus/test";

import {
  appendQueuedRequest,
  canAutoDispatchQueuedRequest,
  removeQueuedRequest,
} from "./requestQueueStore";

const first = { id: "one", text: "First request", createdAt: "2026-08-04T00:00:00.000Z" };
const second = { id: "two", text: "Second request", createdAt: "2026-08-04T00:00:01.000Z" };

describe("request queue", () => {
  it("keeps FIFO order per thread", () => {
    const state = appendQueuedRequest(
      appendQueuedRequest({}, "thread-a", first),
      "thread-a",
      second,
    );
    expect(state["thread-a"]).toEqual([first, second]);
  });

  it("removes one request without touching another thread", () => {
    const state = { "thread-a": [first, second], "thread-b": [first] };
    expect(removeQueuedRequest(state, "thread-a", "one")).toEqual({
      "thread-a": [second],
      "thread-b": [first],
    });
  });

  it("drops an empty thread bucket", () => {
    expect(removeQueuedRequest({ "thread-a": [first] }, "thread-a", "one")).toEqual({});
  });

  it("drains only a settled, unblocked, non-failed head request", () => {
    expect(
      canAutoDispatchQueuedRequest({
        request: first,
        running: false,
        blocked: false,
        failedRequestId: null,
      }),
    ).toBe(true);
    expect(
      canAutoDispatchQueuedRequest({
        request: first,
        running: true,
        blocked: false,
        failedRequestId: null,
      }),
    ).toBe(false);
    expect(
      canAutoDispatchQueuedRequest({
        request: first,
        running: false,
        blocked: true,
        failedRequestId: null,
      }),
    ).toBe(false);
    expect(
      canAutoDispatchQueuedRequest({
        request: first,
        running: false,
        blocked: false,
        failedRequestId: first.id,
      }),
    ).toBe(false);
  });
});
