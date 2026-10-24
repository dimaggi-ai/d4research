import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { runMonitorBenchmark } from "./AgentMonitorReactor.benchmark.ts";

it.live("keeps idle sweeps bounded on 694 threads and 140926 turn items without writes", () =>
  Effect.gen(function* () {
    const result = yield* runMonitorBenchmark(false);
    expect(result.threads).toBe(694);
    expect(result.turnItems).toBe(140_926);
    expect(result.events).toBe(140_926);
    // CI contention can exceed the 50 ms workstation goal; per-thread rescans cannot.
    expect(result.idleSweepP95Ms).toBeLessThan(100);
  }),
);
