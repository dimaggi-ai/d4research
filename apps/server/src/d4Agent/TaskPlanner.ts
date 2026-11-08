import type { D4AgentAction, D4AgentTaskPlan } from "@d4research/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

type StartAction = Extract<D4AgentAction, { type: "start" }>;

export interface TaskPlanInput {
  readonly action: StartAction;
  readonly projectTitle: string;
  readonly workspaceRoot: string;
  readonly workspace: "root" | "worktree";
}

/**
 * Jev (TypeSafe System One) judgments about a drafted start card. A missing key, an outage or an
 * unusable reply yields null: planning advice must never block the user from approving work.
 */
export class TaskPlanner extends Context.Service<
  TaskPlanner,
  { readonly plan: (input: TaskPlanInput) => Effect.Effect<D4AgentTaskPlan | null> }
>()("d4research/d4Agent/TaskPlanner") {}

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";

const Noul = Schema.Struct({ type: Schema.Literal("noul"), noul: Schema.Number });
const Response = Schema.Struct({
  model: Schema.String,
  answers: Schema.Struct({
    self_contained: Noul,
    done_when_verifiable: Noul,
    mode: Schema.Struct({
      type: Schema.Literal("choice"),
      choice: Schema.Literals(["single", "loop"]),
      probabilities: Schema.Record(Schema.String, Schema.Number),
    }),
    scope_size: Schema.Struct({ type: Schema.Literal("score"), score: Schema.Number }),
  }),
});
const decodeResponse = Schema.decodeUnknownEffect(Response);

const planQuestions = {
  self_contained: {
    type: "noul",
    instructions:
      "`brief` is the complete message an autonomous coding agent will receive; it cannot see the conversation that produced it. Does `brief` contain everything needed to start, without relying on unstated earlier context such as 'as discussed', 'that bug', 'the same fix' or unnamed files?",
  },
  done_when_verifiable: {
    type: "noul",
    instructions:
      "Does `brief.doneWhen` (or `brief.completionCriteria` for a loop) name a concrete check the agent can run or observe, such as a command, a test, a file state or a visible result, rather than a vague goal like 'it works' or 'improve it'?",
  },
  mode: {
    type: "choice",
    instructions:
      "Which execution mode fits the work in `brief.text`? Judge the work, not the mode the brief already names.",
    criteria: {
      single:
        "One bounded change or investigation that a single run can finish and verify, such as a bug fix, a small feature or a report.",
      loop: "Iterative work that needs repeated attempts against explicit criteria, such as driving a failing suite to green, tuning until a metric is met or migrating many items.",
    },
  },
  scope_size: {
    type: "score",
    instructions: "How large is the work requested in `brief.text`?",
    criteria: [
      "Small: one focused change in a few files.",
      "Medium: one feature or fix that touches several files or one subsystem.",
      "Large: work across several subsystems or surfaces, or a sizable redesign.",
      "Several independent tasks bundled in one brief that could each be their own task.",
    ],
  },
} as const;

// Policy thresholds on Jev's probabilities. They are starting values, not evaluated cut-offs:
// refusals fire only on a confident "no" so a borderline brief still reaches the user.
const REFUSE_BELOW = 0.2;
const MODE_ADVICE_AT = 0.75;
const LARGE_SCOPE_AT = 1.75;

function planNotes(plan: Omit<D4AgentTaskPlan, "notes">, action: StartAction): string[] {
  const notes: string[] = [];
  const mode = action.mode ?? "single";
  if (plan.suggestedMode !== mode && plan.suggestedModeProbability >= MODE_ADVICE_AT)
    notes.push(`Jev suggests ${plan.suggestedMode} mode for this work.`);
  if (plan.scopeSize >= LARGE_SCOPE_AT)
    notes.push("Jev rates this scope as large. Consider a scope review before approving.");
  return notes;
}

/** A confident Jev "no" on a brief requirement, as a redraft instruction for Nia. */
export function planProblem(plan: D4AgentTaskPlan): string | null {
  if (plan.selfContained < REFUSE_BELOW)
    return "The brief relies on context the task thread cannot see. Restate the needed facts, files and decisions in the brief itself.";
  if (plan.doneWhenVerifiable < REFUSE_BELOW)
    return "The done-when check is not verifiable. Name a command, test or observable result that proves the task is finished.";
  return null;
}

const askJev = Effect.fn("askJev")(
  function* (input: TaskPlanInput, apiKey: string) {
    const { action } = input;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(JEV_URL).pipe(
        HttpClientRequest.bearerToken(apiKey),
        HttpClientRequest.bodyJsonUnsafe({
          model: JEV_MODEL,
          state: {
            project: input.projectTitle,
            targetDirectory: input.workspaceRoot,
            workspace: input.workspace,
            brief: {
              text: action.text,
              mode: action.mode ?? "single",
              constraints: action.constraints ?? null,
              doneWhen: action.doneWhen ?? null,
              completionCriteria: action.completionCriteria ?? null,
            },
          },
          questions: planQuestions,
        }),
      ),
    );
    if (response.status !== 200) return null;
    const { model, answers } = yield* decodeResponse(yield* response.json);
    const base = {
      model: model.slice(0, 128),
      selfContained: answers.self_contained.noul,
      doneWhenVerifiable: answers.done_when_verifiable.noul,
      suggestedMode: answers.mode.choice,
      suggestedModeProbability: answers.mode.probabilities[answers.mode.choice] ?? 0,
      scopeSize: answers.scope_size.score,
    };
    return { ...base, notes: planNotes(base, action) } satisfies D4AgentTaskPlan;
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed(null) }),
      Effect.catch(() => Effect.succeed(null)),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.provide(FetchHttpClient.layer),
    ),
);

/** The server-side key stays in the server environment; without it planning is skipped. */
export const jevPlanner = TaskPlanner.of({
  plan: Effect.fn("TaskPlanner.plan")(function* (input) {
    const apiKey = process.env.TYPESAFE_API_KEY?.trim();
    return apiKey ? yield* askJev(input, apiKey) : null;
  }),
});
