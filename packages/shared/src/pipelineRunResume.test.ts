import { describe, expect, it } from "vite-plus/test";

import {
  pendingPipelineResume,
  resumeContextFor,
  type ResumeChainMessage,
  type ResumeChainRun,
} from "./pipelineRunResume.ts";

const run = (
  id: string,
  ordinal: number,
  status: string,
  startedAt: string | null = "2026-10-27T16:00:00Z",
): ResumeChainRun => ({ id, ordinal, status, startedAt, userMessageId: `m-${id}` });

const message = (runId: string, text: string): ResumeChainMessage => ({
  id: `m-${runId}`,
  role: "user",
  text,
});

const trigger = message("r1", "!research:default Audit the model router");

describe("pendingPipelineResume", () => {
  it("offers a restart resume for a started pipeline run that a restart cancelled", () => {
    expect(
      pendingPipelineResume({ runs: [run("r1", 1, "cancelled")], messages: [trigger] }),
    ).toEqual({ chain: [run("r1", 1, "cancelled")], interruption: "restart" });
  });

  it("keeps a user stop distinct from a restart", () => {
    expect(
      pendingPipelineResume({ runs: [run("r1", 1, "interrupted")], messages: [trigger] })
        ?.interruption,
    ).toBe("user");
  });

  it("skips a run that never started and resumes the cancelled run before it", () => {
    const runs = [run("r1", 1, "cancelled"), run("r2", 2, "cancelled", null)];
    const resume = pendingPipelineResume({
      runs,
      messages: [trigger, message("r2", "continue")],
    });
    expect(resume?.chain.map((entry) => entry.id)).toEqual(["r1"]);
  });

  it("chains a failed resume back to the original interrupted run", () => {
    const runs = [run("r1", 1, "cancelled"), run("r2", 2, "failed")];
    const resume = pendingPipelineResume({
      runs,
      messages: [trigger, message("r2", "continue")],
    });
    expect(resume?.chain.map((entry) => entry.id)).toEqual(["r2", "r1"]);
    expect(resume?.interruption).toBe("failed");
  });

  it("offers nothing while a run is active, after a completed run, or without a pipeline", () => {
    expect(
      pendingPipelineResume({
        runs: [run("r1", 1, "cancelled"), run("r2", 2, "running")],
        messages: [trigger],
      }),
    ).toBeNull();
    expect(
      pendingPipelineResume({ runs: [run("r1", 1, "completed")], messages: [trigger] }),
    ).toBeNull();
    expect(
      pendingPipelineResume({
        runs: [run("r1", 1, "cancelled")],
        messages: [message("r1", "plain chat")],
      }),
    ).toBeNull();
  });
});

describe("resumeContextFor", () => {
  it("treats a follow-up after an interrupted pipeline run as its resume", () => {
    const runs = [run("r1", 1, "cancelled"), run("r2", 2, "running")];
    const resume = resumeContextFor({
      runs,
      messages: [trigger, message("r2", "continue")],
      currentRunId: "r2",
    });
    expect(resume?.chain.map((entry) => entry.id)).toEqual(["r1"]);
  });

  it("treats a new pipeline trigger as a fresh run", () => {
    const runs = [run("r1", 1, "cancelled"), run("r2", 2, "running")];
    expect(
      resumeContextFor({
        runs,
        messages: [trigger, message("r2", "Ultrathink:\n!research:default Start over")],
        currentRunId: "r2",
      }),
    ).toBeNull();
  });
});
