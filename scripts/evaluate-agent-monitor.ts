import {
  classifyThreadLiveness,
  type ThreadLivenessEvidence,
  type ThreadLivenessResult,
} from "@d4research/shared/threadLiveness";

const baseline: ThreadLivenessEvidence = {
  runId: "evaluation-run",
  attemptId: "evaluation-attempt",
  runStatus: "running",
  waitingBackground: false,
  providerState: "running",
  lastProgressAt: 1_000_000,
  now: 1_000_001,
  leaseExpired: false,
  leaseRenewalSupported: false,
};

type FaultCase = readonly [
  Partial<ThreadLivenessEvidence>,
  ThreadLivenessResult["classification"],
  boolean,
];

const cases: FaultCase[] = [
  [{}, "working", false],
  [{ now: 1_120_000 }, "slow", false],
  [{ now: 1_600_000 }, "suspected_stuck", true],
  [{ now: 87_400_000, leaseExpired: true }, "suspected_stuck", true],
  [{ now: 900_000 }, "working", false],
  [{ lastProgressAt: null }, "working", false],
  [{ lastProgressAt: "invalid" }, "working", false],
  [{ providerState: "unknown", now: 87_400_000 }, "working", false],
  [{ waitingBackground: true, now: 87_400_000 }, "waiting_background", false],
  [{ runStatus: "completed", waitingBackground: true }, "waiting_background", false],
  [
    { pendingRequestId: "tool", pendingRequestKind: "dynamic_tool_call" },
    "waiting_background",
    false,
  ],
  [{ runStatus: "failed", failureClass: "usage_limit" }, "limited", true],
  [{ runStatus: "failed" }, "failed", true],
  [{ runStatus: null }, "idle", false],
  [{ providerState: "error" }, "wedged", true],
  [{ providerState: "absent" }, "wedged", true],
];

for (const runStatus of ["completed", "interrupted", "cancelled", "rolled_back"] as const) {
  cases.push([{ runStatus, providerState: "error" }, "idle", false]);
}
for (const runStatus of ["queued", "preparing", "waiting"] as const) {
  cases.push([{ runStatus, providerState: "absent" }, "working", false]);
}
for (const pendingRequestKind of [
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
  "user_input",
  "auth_refresh",
] as const) {
  cases.push([
    {
      pendingRequestId: "request",
      pendingRequestKind,
      providerState: "error",
      now: 87_400_000,
    },
    "needs_user",
    true,
  ]);
}

let checks = 0;
let failed = 0;
const check = (passed: boolean) => {
  checks += 1;
  if (!passed) failed += 1;
};
const classifications: Record<ThreadLivenessResult["classification"], number> = {
  needs_user: 0,
  waiting_background: 0,
  working: 0,
  slow: 0,
  suspected_stuck: 0,
  wedged: 0,
  limited: 0,
  failed: 0,
  idle: 0,
};
let attentionReports = 0;
for (const [overrides, expected, attentionRequired] of cases) {
  const result = classifyThreadLiveness({ ...baseline, ...overrides });
  check(result.classification === expected);
  check(result.attentionRequired === attentionRequired);
  classifications[result.classification] += 1;
  if (result.attentionRequired) attentionReports += 1;
}

const threadCount = 500;
const keys = new Set<string>();
for (let index = 0; index < threadCount; index += 1) {
  const input = Object.freeze({ ...baseline, runId: `evaluation-run-${index}` });
  const result = classifyThreadLiveness(input);
  keys.add(result.reportKey);
  check(result.classification === "working" && !result.attentionRequired);
  check(
    result.reportKey === classifyThreadLiveness({ ...input, now: input.now + 1_000 }).reportKey,
  );
  check(
    result.reportKey !== classifyThreadLiveness({ ...input, attemptId: "next-attempt" }).reportKey,
  );
}
check(keys.size === threadCount);

process.stdout.write(
  `${JSON.stringify({
    cases: cases.length,
    threads: threadCount,
    checks,
    passed: checks - failed,
    failed,
    classifications,
    attentionReports,
  })}\n`,
);
process.exitCode = failed === 0 ? 0 : 1;
