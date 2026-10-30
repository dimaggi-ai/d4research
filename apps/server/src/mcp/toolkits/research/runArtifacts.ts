// @effect-diagnostics effectFnOpportunity:warning -- d4research module predating the Effect.fn style rule.
import { ServerConfig } from "../../../config.ts";
import * as HostProcess from "@d4research/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off - Native no-follow file handles and exclusive publishing protect artifact boundaries.
import { exportResearchNote } from "./noteExport.ts";
import * as NodeCrypto from "node:crypto";
import {
  appendLedger,
  publishArtifact,
  safeDirectory,
  safeRead,
  safeList,
} from "./artifactFiles.ts";
import { redactSecrets } from "../../../second-brain/secrets.ts";
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
  threadId: Schema.optional(Schema.String),
  notesError: Schema.optional(Schema.String),
  contentHash: Schema.optional(Schema.String),
  requestHash: Schema.optional(Schema.String),
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
  readonly requestHash?: string;
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
    | {
        readonly ok: false;
        readonly detail: string;
        readonly failureKind: string;
        readonly partialText?: string;
      };
}

export const researchRunDirectoryName = (threadId: ThreadId | string): string =>
  String(threadId)
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll("..", "-") || "thread";

export const researchRunDirectory = (
  path: Path.Path,
  workspaceRoot: string,
  threadId: ThreadId | string,
): string => path.join(workspaceRoot, RESEARCH_RUNS_DIRECTORY, researchRunDirectoryName(threadId));

const LocationJson = Schema.fromJsonString(Schema.String);
const decodeLocation = Schema.decodeUnknownSync(LocationJson);
const encodeLocation = Schema.encodeSync(LocationJson);
// An exact-thread pointer survives project workspace edits. It does not scan or
// migrate historical folders, and never reads another context's index.
export const resolveResearchRunDirectory = (
  workspaceRoot: string,
  threadId: string,
  bind = false,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const platform = yield* HostProcess.Platform;
    const config = yield* Effect.serviceOption(ServerConfig);
    const fallback = researchRunDirectory(path, workspaceRoot, threadId);
    if (Option.isNone(config)) return fallback;
    const directory = path.join(config.value.stateDir, "research-artifact-locations");
    const file = path.join(
      directory,
      `${NodeCrypto.createHash("sha256").update(threadId).digest("hex")}.json`,
    );
    if (!(yield* fs.exists(file)) && bind) {
      yield* Effect.tryPromise(() => safeDirectory(directory, true, platform));
      yield* Effect.tryPromise(() =>
        publishArtifact(file, encodeLocation(fallback), platform),
      ).pipe(
        Effect.catchIf(
          (error) => (error.cause as { code?: string })?.code === "EEXIST",
          () => Effect.void,
        ),
      );
    }
    if (!(yield* fs.exists(file))) return fallback;
    return decodeLocation(yield* Effect.tryPromise(() => safeRead(file, platform)));
  });

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

export const renderArtifact = (outcome: DelegationOutcome, at: string): string => {
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
  return redactSecrets(
    `${header.join("\n")}${outcome.result.ok ? outcome.result.text : `${outcome.result.detail}${outcome.result.partialText ? `\n\n## Partial output\n\n${outcome.result.partialText}` : ""}`}\n`,
  );
};

export const parseLedger = (text: string): ReadonlyArray<ResearchLedgerEntry> =>
  // A torn final line from a crash must not hide every earlier outcome.
  text.split("\n").flatMap((line) => Option.toArray(decodeLedgerLine(line)));

// Parallel delegations of one run share a ledger; one permit keeps `seq`
// unique. Writes are a few KB, so a process-wide lock costs nothing.
const writeLock = Semaphore.makeUnsafe(1);

export const readResearchLedger = (runDirectory: string) =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const ledgerPath = path.join(runDirectory, RESEARCH_LEDGER_FILE);
    const entries = (yield* fs.exists(ledgerPath))
      ? parseLedger(yield* Effect.tryPromise(() => safeRead(ledgerPath, platform)))
      : [];
    const receipts = path.join(runDirectory, "receipts");
    if (!(yield* fs.exists(receipts))) return entries;
    const recovered: ResearchLedgerEntry[] = [];
    const known = new Set(entries.map((entry) => entry.artifact));
    for (const name of yield* Effect.tryPromise(() => safeList(receipts, platform))) {
      if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) continue;
      if (known.has(`steps/${name.slice(0, -5)}`)) continue;
      const decoded = decodeLedgerLine(
        yield* Effect.tryPromise(() => safeRead(path.join(receipts, name), platform)).pipe(
          Effect.orElseSucceed(() => ""),
        ),
      );
      if (Option.isNone(decoded)) continue;
      const entry = decoded.value;
      if (
        known.has(entry.artifact) ||
        !/^steps\/[A-Za-z0-9._-]+\.md$/.test(entry.artifact) ||
        entry.artifact.includes("..")
      )
        continue;
      const artifactPath = path.join(runDirectory, entry.artifact);
      if (!(yield* fs.exists(artifactPath))) continue;
      const text = yield* Effect.tryPromise(() => safeRead(artifactPath, platform)).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (
        text === null ||
        !entry.contentHash ||
        NodeCrypto.createHash("sha256").update(text).digest("hex") !== entry.contentHash
      )
        continue;
      recovered.push(entry);
      known.add(entry.artifact);
    }
    return [...entries, ...recovered].sort((a, b) => a.seq - b.seq);
  });

/**
 * Persists one delegation outcome. Never fails: an unwritable workspace logs a
 * warning and the delegation result still reaches the orchestrator.
 */
export const recordDelegationOutcome = (input: {
  readonly runDirectory: string;
  readonly outcome: DelegationOutcome;
  readonly notes?: { folder: string; projectId: string; threadId: string };
}) =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { outcome, runDirectory } = input;
    const stepsDirectory = path.join(runDirectory, STEPS_DIRECTORY);
    yield* Effect.tryPromise(() => safeDirectory(stepsDirectory, true, platform));
    const previous = yield* readResearchLedger(runDirectory);
    const seq = previous.reduce((max, entry) => Math.max(max, entry.seq), 0) + 1;
    const at = DateTime.formatIso(DateTime.makeUnsafe(outcome.completedAtMs));
    let artifact = `${STEPS_DIRECTORY}/${stepArtifactName(seq, outcome)}`;
    // A crash can publish a file before appending its ledger record. Preserve it.
    if (
      (yield* fs.exists(path.join(runDirectory, artifact))) ||
      (yield* fs.exists(path.join(runDirectory, "receipts", `${path.basename(artifact)}.json`)))
    )
      artifact = artifact.replace(/\.md$/, `-${NodeCrypto.randomUUID()}.md`);
    const artifactPath = path.join(runDirectory, artifact);
    const entry: ResearchLedgerEntry = {
      ...(input.notes ? { threadId: input.notes.threadId } : {}),
      ...(outcome.requestHash ? { requestHash: outcome.requestHash } : {}),
      contentHash: NodeCrypto.createHash("sha256")
        .update(renderArtifact(outcome, at))
        .digest("hex"),
      seq,
      at,
      runId: outcome.runId,
      step: redactSecrets(outcome.step),
      visit: outcome.visit,
      requestedTarget: redactSecrets(outcome.requestedTarget),
      resolvedTarget: redactSecrets(outcome.resolvedTarget),
      substituted: outcome.substituted,
      outcome: outcome.result.ok ? "success" : "failure",
      ...(outcome.result.ok ? {} : { failureKind: outcome.result.failureKind }),
      durationMs: outcome.durationMs,
      chars: outcome.result.ok
        ? outcome.result.text.length
        : (outcome.result.partialText?.length ?? outcome.result.detail.length),
      truncated: outcome.result.ok && outcome.result.truncated,
      artifact,
    };
    // The receipt precedes publication so a crash between file and ledger writes
    // can be recovered without inferring ownership from arbitrary workspace files.
    const receipts = path.join(runDirectory, "receipts");
    yield* Effect.tryPromise(() => safeDirectory(receipts, true, platform));
    yield* Effect.tryPromise(() =>
      publishArtifact(
        path.join(receipts, `${path.basename(artifact)}.json`),
        encodeLedgerLine({
          ...entry,
          ...(input.notes?.folder
            ? {
                notesError:
                  "Notes export was interrupted. The artifact remains saved in the project.",
              }
            : {}),
        }),
        platform,
      ),
    );
    yield* Effect.tryPromise(() =>
      publishArtifact(artifactPath, renderArtifact(outcome, at), platform),
    );
    const notesError = input.notes?.folder
      ? yield* exportResearchNote({
          ...input.notes,
          runId: outcome.runId,
          seq,
          text: renderArtifact(outcome, at),
        }).pipe(
          Effect.match({
            onSuccess: () => null,
            onFailure: () => "Notes export failed. The artifact remains saved in the project.",
          }),
        )
      : null;
    const finalEntry = { ...entry, ...(notesError ? { notesError } : {}) };
    // One short O_APPEND write per line; the artifact it names already exists.
    yield* Effect.tryPromise(() =>
      appendLedger(
        path.join(runDirectory, RESEARCH_LEDGER_FILE),
        `\n${encodeLedgerLine(finalEntry)}\n`,
        platform,
      ),
    );
    return finalEntry;
  }).pipe(
    writeLock.withPermits(1),
    Effect.uninterruptible,
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
  const identity = (entry: ResearchLedgerEntry) =>
    `${entry.runId}→${entry.step}→${entry.visit}→${entry.resolvedTarget}`;
  const terminal = new Set(
    entries
      .filter((entry) => entry.failureKind !== "partial" && entry.failureKind !== "budget")
      .map(identity),
  );
  const partialSeen = new Set<string>();
  for (const entry of entries) {
    if (!chainBudgetRunIds.has(entry.runId) || entry.failureKind === "budget") continue;
    if (entry.failureKind === "partial") {
      const id = identity(entry);
      if (terminal.has(id) || partialSeen.has(id)) continue;
      partialSeen.add(id);
    }
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
  readonly threadId?: string;
}) =>
  Effect.gen(function* () {
    const platform = yield* HostProcess.Platform;
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
    const scoped =
      input.threadId === undefined
        ? null
        : (yield* readResearchLedger(input.runDirectory)).filter((entry) =>
            entryBelongsToThread(entry, input.threadId!),
          );
    if (
      scoped &&
      input.artifact !== RESEARCH_LEDGER_FILE &&
      !scoped.some((entry) => entry.artifact === input.artifact)
    )
      return { ok: false as const, detail: "Artifact is not in this thread's ledger." };
    const text =
      scoped && input.artifact === RESEARCH_LEDGER_FILE
        ? scoped.map((entry) => encodeLedgerLine(entry)).join("\n")
        : yield* Effect.tryPromise(() => safeRead(artifactPath, platform));
    if (input.artifact !== RESEARCH_LEDGER_FILE) {
      const entries = yield* readResearchLedger(input.runDirectory);
      const entry = entries.find((entry) => entry.artifact === input.artifact);
      if (
        entry?.contentHash &&
        NodeCrypto.createHash("sha256").update(text).digest("hex") !== entry.contentHash
      )
        return {
          ok: false as const,
          detail: "Saved artifact changed after recording. Restore the original before continuing.",
        };
    }
    const offset = Math.min(Math.max(0, input.offset), text.length);
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
    const runDirectory =
      input.workspaceRoot === undefined
        ? null
        : yield* resolveResearchRunDirectory(input.workspaceRoot, input.threadId);
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

// Legacy ledgers lack threadId; their server budget key still carries exact thread scope.
export const entryBelongsToThread = (entry: ResearchLedgerEntry, threadId: string): boolean =>
  entry.threadId !== undefined
    ? entry.threadId === threadId
    : entry.runId.startsWith(`${threadId}:`);
