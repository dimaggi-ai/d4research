import { ProjectId, ProviderInstanceId, type D4AgentAction } from "@d4research/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  composeStartPrompt,
  launchPreviewsMatch,
  parseTaskOutcome,
  startActionProblem,
  startTaskMode,
} from "./taskLaunch.ts";

const start = (
  overrides: Partial<Extract<D4AgentAction, { type: "start" }>> = {},
): Extract<D4AgentAction, { type: "start" }> => ({
  type: "start",
  projectId: ProjectId.make("project"),
  text: "Fix the flaky login test.",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
  doneWhen: "pnpm test login passes 20 runs in a row.",
  ...overrides,
});
const root = { workspaceRoot: "/repo", workspace: "root" } as const;

describe("start task modes", () => {
  it("treats a start card without a mode as a single task", () => {
    assert.equal(startTaskMode(start()), "single");
    assert.isNull(startActionProblem(start()));
  });

  it("asks a single task to verify and report its outcome before it settles", () => {
    const prompt = composeStartPrompt(start(), root);
    assert.isTrue(prompt.startsWith("Fix the flaky login test.\n\n---\nBrief\n"));
    assert.include(prompt, "Single task.");
    assert.include(prompt, "Outcome: completed");
    assert.include(prompt, "a finished turn is not proof of success");
    assert.include(prompt, "settles automatically after a verified completion");
  });

  it("gives the task thread a self-contained brief with target, constraints and done-when", () => {
    const prompt = composeStartPrompt(start({ constraints: "Do not touch CI config." }), root);
    assert.include(prompt, "Target directory: /repo. Work only inside it.");
    assert.include(prompt, "Constraints: Do not touch CI config.");
    assert.include(prompt, "Done when: pnpm test login passes 20 runs in a row.");
    assert.include(prompt, "you cannot see the conversation that produced it");
    assert.include(
      composeStartPrompt(start(), { workspaceRoot: "/repo", workspace: "worktree" }),
      "a fresh worktree of /repo created for this task",
    );
  });

  it("refuses a single task without a done-when check", () => {
    const { doneWhen: _doneWhen, ...withoutCheck } = start();
    assert.include(startActionProblem(withoutCheck) ?? "", "doneWhen");
  });

  it("refuses a loop without completion criteria", () => {
    assert.include(startActionProblem(start({ mode: "loop" })) ?? "", "completionCriteria");
    assert.include(startActionProblem(start({ maxIterations: 3 })) ?? "", "loop");
  });

  it("runs a loop until its criteria hold, with no iteration cap, and keeps it open", () => {
    const prompt = composeStartPrompt(
      start({ mode: "loop", completionCriteria: "All login tests pass 20 times." }),
      root,
    );
    assert.notInclude(prompt, "Done when:");
    assert.include(prompt, "Loop task.");
    assert.include(prompt, "Keep going until every criterion holds.");
    assert.notInclude(prompt, "budget");
    assert.notInclude(prompt, "at most");
    assert.include(prompt, "All login tests pass 20 times.");
    assert.include(prompt, "This thread stays open after it reports.");
    assert.include(prompt, "you need the user's input");
  });

  it("stops a loop at a budget only when the user chose one", () => {
    const prompt = composeStartPrompt(
      start({ mode: "loop", completionCriteria: "Done.", maxIterations: 40 }),
      root,
    );
    assert.include(prompt, "The user set a budget of 40 iterations");
    assert.include(prompt, "`Outcome: needs-input`");
  });
});

describe("parseTaskOutcome", () => {
  it("reads the worker's final outcome line", () => {
    assert.equal(parseTaskOutcome("Done.\nOutcome: completed\nTests: 12 passed"), "completed");
    assert.equal(parseTaskOutcome("**Outcome:** blocked — no credentials"), "blocked");
    assert.equal(
      parseTaskOutcome("Outcome: failed\nretrying\nOutcome: needs-input"),
      "needs-input",
    );
  });

  it("does not infer success when the worker gave no outcome", () => {
    assert.isNull(parseTaskOutcome("I fixed it."));
    assert.isNull(parseTaskOutcome("The outcome was completed successfully."));
  });
});

describe("launchPreviewsMatch", () => {
  const preview = {
    projectId: ProjectId.make("project"),
    workspaceRoot: "/work/project",
    workspace: "root" as const,
    runtimeMode: "approval-required",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
    mode: "single" as const,
    prompt: "Fix it.",
  };

  it("matches only when every approved launch detail is unchanged", () => {
    assert.isTrue(launchPreviewsMatch(preview, { ...preview }));
    assert.isFalse(launchPreviewsMatch(preview, { ...preview, workspaceRoot: "/elsewhere" }));
    assert.isFalse(launchPreviewsMatch(preview, { ...preview, runtimeMode: "auto" }));
    assert.isFalse(launchPreviewsMatch(preview, { ...preview, prompt: "Fix it twice." }));
    assert.isFalse(
      launchPreviewsMatch(preview, {
        ...preview,
        modelSelection: { ...preview.modelSelection, model: "other" },
      }),
    );
  });
});
