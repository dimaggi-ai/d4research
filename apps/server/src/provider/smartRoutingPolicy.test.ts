import { assert, describe, it } from "@effect/vitest";

import { localRouteReason, type RecentRouteOutcome } from "./smartRoutingPolicy.ts";

const healthy = {
  taskMode: "text",
  hasAttachments: false,
  available: true,
  health: "healthy",
  contextTokens: 1000,
  contextWindowTokens: 32768,
  recent: [],
} as const;
const sample = (outcome = "completed", latencyMs = 1000, timeout = false): RecentRouteOutcome => ({
  outcome,
  latencyMs,
  timeout,
});

describe("localRouteReason", () => {
  it("uses fixed precedence for tools, availability, context, and health", () => {
    assert.equal(localRouteReason(healthy), "local_healthy");
    assert.equal(
      localRouteReason({ ...healthy, taskMode: "tools", available: false }),
      "task_requires_tools",
    );
    assert.equal(localRouteReason({ ...healthy, hasAttachments: true }), "task_requires_tools");
    assert.equal(
      localRouteReason({ ...healthy, available: false, health: "unhealthy" }),
      "local_unavailable",
    );
    assert.equal(
      localRouteReason({ ...healthy, contextTokens: 28673, health: "unhealthy" }),
      "context_pressure",
    );
    assert.equal(localRouteReason({ ...healthy, contextTokens: 28672 }), "local_healthy");
    assert.equal(localRouteReason({ ...healthy, health: "unknown" }), "endpoint_unhealthy");
  });

  it("requires three completed or failed observations before acting on recent outcomes", () => {
    assert.equal(
      localRouteReason({
        ...healthy,
        recent: [sample("failed", 90000, true), sample("failed", 90000, true)],
      }),
      "local_healthy",
    );
    assert.equal(
      localRouteReason({
        ...healthy,
        recent: [
          sample("cancelled", 90000, true),
          sample("interrupted", 90000, true),
          sample("abandoned", 90000, true),
        ],
      }),
      "local_healthy",
    );
    assert.equal(
      localRouteReason({ ...healthy, recent: [sample(), sample(), sample("failed", 1000, true)] }),
      "recent_timeouts",
    );
    assert.equal(
      localRouteReason({ ...healthy, recent: [sample(), sample("failed"), sample("failed")] }),
      "recent_errors",
    );
  });

  it("uses the 90th percentile with a strict 60000 millisecond latency threshold", () => {
    assert.equal(
      localRouteReason({ ...healthy, recent: [sample(), sample(), sample("completed", 60000)] }),
      "local_healthy",
    );
    assert.equal(
      localRouteReason({ ...healthy, recent: [sample(), sample(), sample("completed", 60001)] }),
      "recent_latency",
    );
    const many = Array.from({ length: 10 }, () => sample());
    many[9] = sample("completed", 90000);
    assert.equal(localRouteReason({ ...healthy, recent: many }), "local_healthy");
  });
});

it("uses exact error and timeout rate boundaries", () => {
  assert.equal(
    localRouteReason({
      ...healthy,
      recent: [sample(), sample(), sample(), sample("completed", 1000, true)],
    }),
    "recent_timeouts",
  );
  assert.equal(
    localRouteReason({
      ...healthy,
      recent: [sample(), sample(), sample(), sample(), sample("completed", 1000, true)],
    }),
    "local_healthy",
  );
  assert.equal(
    localRouteReason({
      ...healthy,
      recent: [sample(), sample(), sample("failed"), sample("failed")],
    }),
    "recent_errors",
  );
  assert.equal(
    localRouteReason({ ...healthy, recent: [sample(), sample(), sample("failed")] }),
    "local_healthy",
  );
  assert.equal(
    localRouteReason({
      ...healthy,
      recent: [sample(), sample(), { outcome: "completed", latencyMs: null, timeout: false }],
    }),
    "local_healthy",
  );
});
