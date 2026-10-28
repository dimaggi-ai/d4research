import type { ThreadId } from "@d4research/contracts";
import {
  type ResumeChainMessage,
  type ResumeChainRun,
  resumeContextFor,
} from "@d4research/shared/pipelineRunResume";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

/**
 * Server-owned record of every pipeline delegation. The transcript alone is
 * not durable enough: a restart cancels the run, and the orchestrator model
 * only writes the files it remembers to write. Each outcome lands here before
 * `research_delegate` returns, so a resumed run (or a person) can read it back.
 *
 * Layout, under the project's workspace root, next to the `research-runs/`
 * files pipelines already write:
 *   research-runs/<thread>/ledger.jsonl          append-only, one line per outcome
 *   research-runs/<thread>/steps/NNN-step<k>-v<visit>-<target>.md
 * `<thread>` is the thread id, not its title, so a rename cannot orphan a run.
 */
export const RESEARCH_RUNS_DIRECTORY = "research-runs";
export const RESEARCH_LEDGER_FILE = "ledger.jsonl";
const STEPS_DIRECTORY = "steps";

export const ResearchLedgerEntry = Schema.Struct({
  seq: Schema.Int,
  at: Schema.String,
  /** Budget key of the orchestrator turn: `<threadId>:<runId>`. */
  runId: Schema.String,
  step: Schema.String,
  visit: Schema.Int,
  requestedTarget: Schema.String,
  resolvedTarget: Schema.String,
  substituted: Schema.Boolean,
  outcome: Schema.Literals(["success", "failure"]),
  failureKind: Schema.optional(Schema.String),
  durationMs: Schema.Int,
  chars: Schema.Int,
  truncated: Schema.Boolean,
  /** Path relative to the run directory; what `research_artifact_read` accepts. */
  artifact: Schema.String,
});
export type ResearchLedgerEntry = typeof ResearchLedgerEntry.Type;
const LedgerLine = Schema.fromJsonString(ResearchLedgerEntry);
const decodeLedgerLine = Schema.decodeUnknownOption(LedgerLine);
const encodeLedgerLine = Schema.encodeSync(LedgerLine);

export interface DelegationOutcome {
  readonly runId: string;
  readonly step: string;
  readonly visit: number;
  readonly requestedTarget: string;
  readonly resolvedTarget: string;
  readonly substituted: boolean;
  readonly durationMs: number;
  readonly completedAtMs: number;
  readonly result:
    | { readonly ok: true; readonly text: string; readonly truncated: boolean }
    | { readonly ok: false; readonly detail: string; readonly failureKind: string };
}

export const researchRunDirectoryName = (threadId: ThreadId | string): string =>
  String(threadId).replaceAll(/[^A-Za-z0-9._-]+/g, "-");

export const researchRunDirectory = (
  path: Path.Path,
  workspaceRoot: string,
  threadId: ThreadId | string,
): string => path.join(workspaceRoot, RESEARCH_RUNS_DIRECTORY, researchRunDirectoryName(threadId));

const slugPart = (value: string, maxLength: number): string =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9.]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, maxLength) || "x";

export const stepArtifactName = (
  seq: number,
  outcome: Pick<DelegationOutcome, "step" | "visit" | "resolvedTarget" | "result">,
): string => {
  const stepNumber = /\d+/.exec(outcome.step)?.[0] ?? slugPart(outcome.step, 24);
  const failed = outcome.result.ok ? "" : "-failed";
  return `${String(seq).padStart(3, "0")}-step${stepNumber}-v${outcome.visit}-${slugPart(
    outcome.resolvedTarget,
    60,
  )}${failed}.md`;
};

const renderArtifact = (outcome: DelegationOutcome, at: string): string => {
  const header = [
    `# Step ${outcome.step}, visit ${outcome.visit}`,
    "",
    `- outcome: ${outcome.result.ok ? "success" : `failure (${outcome.result.failureKind})`}`,
    `- requested target: ${outcome.requestedTarget}`,
    `- resolved target: ${outcome.resolvedTarget}${outcome.substituted ? " (labeled fallback)" : ""}`,
    `- duration: ${outcome.durationMs} ms`,
    `- recorded: ${at}`,
    `- run: ${outcome.runId}`,
    ...(outcome.result.ok && outcome.result.truncated
      ? ["- note: the orchestrator received a truncated copy; this file is complete"]
      : []),
    "",
    "---",
    "",
  ];
  return `${header.join("\n")}${outcome.result.ok ? outcome.result.text : outcome.result.detail}\n`;
};

export const parseLedger = (text: string): ReadonlyArray<ResearchLedgerEntry> =>
  // A torn final line from a crash must not hide every earlier outcome.
  text.split("\n").flatMap((line) => Option.toArray(decodeLedgerLine(line)));

// Parallel delegations of one run share a ledger; one permit keeps `seq`
// unique. Writes are a few KB, so a process-wide lock costs nothing.
const writeLock = Semaphore.makeUnsafe(1);

export const readResearchLedger = (runDirectory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const ledgerPath = path.join(runDirectory, RESEARCH_LEDGER_FILE);
    if (!(yield* fs.exists(ledgerPath))) return [];
    return parseLedger(yield* fs.readFileString(ledgerPath));
  });

/**
 * Persists one delegation outcome. Never fails: an unwritable workspace logs a
 * warning and the delegation result still reaches the orchestrator.
 */
export const recordDelegationOutcome = (input: {
  readonly runDirectory: string;
  readonly outcome: DelegationOutcome;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { outcome, runDirectory } = input;
    const stepsDirectory = path.join(runDirectory, STEPS_DIRECTORY);
    yield* fs.makeDirectory(stepsDirectory, { recursive: true });
    const previous = yield* readResearchLedger(runDirectory);
    const seq = previous.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1;
    const at = DateTime.formatIso(DateTime.makeUnsafe(outcome.completedAtMs));
    const artifact = `${STEPS_DIRECTORY}/${stepArtifactName(seq, outcome)}`;
    const artifactPath = path.join(runDirectory, artifact);
    const temporaryPath = `${artifactPath}.tmp`;
    yield* fs.writeFileString(temporaryPath, renderArtifact(outcome, at));
    yield* fs.rename(temporaryPath, artifactPath);
    const entry: ResearchLedgerEntry = {
      seq,
      at,
      runId: outcome.runId,
      step: outcome.step,
      visit: outcome.visit,
      requestedTarget: outcome.requestedTarget,
      resolvedTarget: outcome.resolvedTarget,
      substituted: outcome.substituted,
      outcome: outcome.result.ok ? "success" : "failure",
      ...(outcome.result.ok ? {} : { failureKind: outcome.result.failureKind }),
      durationMs: outcome.durationMs,
      chars: outcome.result.ok ? outcome.result.text.length : outcome.result.detail.length,
      truncated: outcome.result.ok && outcome.result.truncated,
      artifact,
    };
    // One short O_APPEND write per line; the artifact it names already exists.
    yield* fs.writeFileString(
      path.join(runDirectory, RESEARCH_LEDGER_FILE),
      `${encodeLedgerLine(entry)}\n`,
      {
        flag: "a",
      },
    );
    return entry;
  }).pipe(
    writeLock.withPermits(1),
    Effect.catchCause((cause) =>
      Effect.logWarning("Research step artifact could not be written", {
        runDirectory: input.runDirectory,
        step: input.outcome.step,
        cause,
      }).pipe(Effect.as(null)),
    ),
  );

export const budgetRunId = (threadId: ThreadId | string, runId: string): string =>
  `${String(threadId)}:${runId}`;

/**
 * Budget already spent by the runs this turn resumes. A resume continues the
 * same run, so it inherits the ceiling instead of getting a fresh one. Budget
 * refusals spent nothing and are not counted.
 */
export const inheritedBudget = (
  entries: ReadonlyArray<ResearchLedgerEntry>,
  chainBudgetRunIds: ReadonlySet<string>,
): { readonly total: number; readonly perStepTarget: ReadonlyMap<string, number> } => {
  const perStepTarget = new Map<string, number>();
  let total = 0;
  for (const entry of entries) {
    if (!chainBudgetRunIds.has(entry.runId) || entry.failureKind === "budget") continue;
    total += 1;
    const key = `${entry.step}→${entry.resolvedTarget}`;
    perStepTarget.set(key, (perStepTarget.get(key) ?? 0) + 1);
  }
  return { total, perStepTarget };
};

const RESUME_LISTED_ENTRY_LIMIT = 60;

/**
 * The RESUME block a resumed pipeline turn receives. It states only what the
 * ledger proves; it never claims a step ran when the ledger lacks it.
 */
export const formatResumeBlock = (input: {
  readonly runDirectory: string;
  readonly entries: ReadonlyArray<ResearchLedgerEntry>;
  readonly chainBudgetRunIds: ReadonlySet<string>;
  readonly interruption: "restart" | "user" | "failed";
}): string => {
  const entries = input.entries.filter((entry) => input.chainBudgetRunIds.has(entry.runId));
  const reason =
    input.interruption === "restart"
      ? "was cancelled by a server restart"
      : input.interruption === "user"
        ? "was stopped by the user"
        : "failed";
  const lines = [
    "--- RESUME (server ledger, verbatim) ---",
    `The previous run of this pipeline ${reason}. This turn continues that run.`,
  ];
  if (entries.length === 0) {
    lines.push(
      "The server recorded no delegation outcomes for it. Use this thread's transcript to find the last completed step.",
    );
  } else {
    const last = entries[entries.length - 1]!;
    lines.push(
      `Step artifacts: ${input.runDirectory}`,
      `Last step reached: step ${last.step}, visit ${last.visit}.`,
      "Recorded delegations (seq. step/visit. target. outcome. artifact):",
    );
    const shown = entries.slice(-RESUME_LISTED_ENTRY_LIMIT);
    if (shown.length < entries.length)
      lines.push(`(${entries.length - shown.length} earlier entries omitted; see ledger.jsonl)`);
    for (const entry of shown) {
      lines.push(
        `${entry.seq}. step ${entry.step} v${entry.visit}. ${entry.resolvedTarget}${
          entry.substituted ? ` (fallback for ${entry.requestedTarget})` : ""
        }. ${entry.outcome === "success" ? `success, ${entry.chars} chars` : `failure (${entry.failureKind ?? "error"})`}. ${entry.artifact}`,
      );
    }
  }
  lines.push(
    "Continue from the next incomplete step. Do not repeat a delegation that succeeded above: read its full text with research_artifact_read({ artifact }). Delegations made before this turn still count against the run's budget.",
    "--- END RESUME ---",
  );
  return lines.join("\n");
};

/** Matches what one delegation returns to the orchestrator at most. */
export const RESEARCH_ARTIFACT_READ_CHUNK_CHARS = 24_000;
const READABLE_ARTIFACT = /^(?:ledger\.jsonl|steps\/[A-Za-z0-9._-]+\.md)$/;

/**
 * Reads back one file of a thread's own run directory. The name must be one
 * this module writes, so `..`, absolute paths, and other files are refused
 * before any path is joined.
 */
export const readRunArtifact = (input: {
  readonly runDirectory: string;
  readonly artifact: string;
  readonly offset: number;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (!READABLE_ARTIFACT.test(input.artifact) || input.artifact.includes(".."))
      return {
        ok: false as const,
        detail: `"${input.artifact}" is not a step artifact name. Use a path the ledger lists, such as "steps/001-step1-v1-….md" or "ledger.jsonl".`,
      };
    const artifactPath = path.join(input.runDirectory, input.artifact);
    const exists = yield* fs.exists(artifactPath).pipe(Effect.orElseSucceed(() => false));
    if (!exists)
      return {
        ok: false as const,
        detail: `No artifact "${input.artifact}" exists for this thread's run.`,
      };
    const text = yield* fs.readFileString(artifactPath);
    const offset = Math.min(input.offset, text.length);
    const end = Math.min(text.length, offset + RESEARCH_ARTIFACT_READ_CHUNK_CHARS);
    return {
      ok: true as const,
      artifact: input.artifact,
      path: artifactPath,
      offset,
      totalChars: text.length,
      nextOffset: end < text.length ? end : null,
      text: text.slice(offset, end),
    };
  });

/**
 * The RESUME note for a turn that continues an unfinished pipeline run, or ""
 * when the turn is not a resume. Best-effort: an unreadable ledger still
 * yields the note, minus the entries it could not read.
 */
export const buildResumeNote = (input: {
  readonly threadId: ThreadId;
  readonly currentRunId: string;
  readonly runs: ReadonlyArray<ResumeChainRun>;
  readonly messages: ReadonlyArray<ResumeChainMessage>;
  readonly workspaceRoot: string | undefined;
}) =>
  Effect.gen(function* () {
    const resume = resumeContextFor(input);
    if (resume === null) return "";
    const path = yield* Path.Path;
    const runDirectory =
      input.workspaceRoot === undefined
        ? null
        : researchRunDirectory(path, input.workspaceRoot, input.threadId);
    const entries =
      runDirectory === null
        ? []
        : yield* readResearchLedger(runDirectory).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Research ledger unreadable for resume", {
                runDirectory,
                cause,
              }).pipe(Effect.as([])),
            ),
          );
    return formatResumeBlock({
      runDirectory: runDirectory ?? "",
      entries,
      chainBudgetRunIds: new Set(resume.chain.map((run) => budgetRunId(input.threadId, run.id))),
      interruption: resume.interruption,
    });
  });
