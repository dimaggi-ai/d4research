import type { ThreadCheckpointSummary } from "@d4research/client-runtime/state/thread-checkpoints";
import {
  AuthFilesystemReadScope,
  CheckpointRef,
  EnvironmentId,
  MessageId,
  ThreadId,
  RunId,
  type AuthSessionState,
} from "@d4research/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  sessionError: null as string | null,
  sessionAtom: {},
  effects: [] as Array<() => void>,
  checkpoints: [] as ReadonlyArray<ThreadCheckpointSummary>,
  diffInputs: [] as unknown[],
}));

vi.mock("@d4research/client-runtime/state/thread-checkpoints", () => ({
  deriveThreadCheckpointSummaries: () => state.checkpoints,
}));
vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useEffect: (effect: () => void) => state.effects.push(effect),
  useMemo: <A>(factory: () => A) => factory(),
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => state.sessionAtom },
}));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: "connected", error: null } },
  }),
}));
vi.mock("../../state/use-thread-detail", () => ({
  useSelectedThreadProjection: () => ({ projection: {} }),
}));
vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: "/repo" }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === state.sessionAtom ? state.session : null,
    error: atom === state.sessionAtom ? state.sessionError : null,
    isPending: atom === state.sessionAtom && state.session === null,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/queries", () => ({
  useCheckpointDiff: (input: unknown) => {
    state.diffInputs.push(input);
    return { data: null, error: null, isPending: false, refresh: vi.fn() };
  },
}));
vi.mock("../../state/review", () => ({
  reviewEnvironment: { diffPreview: vi.fn() },
}));
vi.mock("./reviewState", () => ({
  setReviewAsyncError: vi.fn(),
  setReviewGitSections: vi.fn(),
  setReviewSelectedSectionId: vi.fn(),
  setReviewTurnDiff: vi.fn(),
  setReviewTurnDiffLoading: vi.fn(),
}));

import { setReviewSelectedSectionId, type ReviewCacheForThread } from "./reviewState";
import { useReviewSections } from "./useReviewSections";

beforeEach(() => {
  vi.clearAllMocks();
  state.effects = [];
  state.diffInputs = [];
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  state.sessionError = null;
  state.checkpoints = [
    {
      runId: RunId.make("turn-1"),
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread/1"),
      status: "ready",
      files: [],
      assistantMessageId: MessageId.make("message-1"),
      completedAt: "2026-04-01T00:00:00.000Z",
    },
  ];
});

const checkpointDiff = "diff --git a/checkpoint.ts b/checkpoint.ts";
const localDiff = "diff --git a/local.ts b/local.ts";
function makeReviewCache(
  kind: "working-tree" | "branch-range" = "working-tree",
): ReviewCacheForThread {
  return {
    threadKey: "environment:thread",
    gitSections: [
      {
        id: kind,
        kind,
        title: "Dirty worktree",
        baseRef: "HEAD",
        headRef: null,
        diff: localDiff,
        diffHash: "cached-local",
        truncated: false,
      },
    ],
    turnDiffById: { "turn:1": checkpointDiff },
    selectedSectionId: `git:${kind}`,
    asyncState: { loadingTurnIds: {}, error: null },
    expandedFileIdsBySection: {},
    revealedLargeFileIdsBySection: {},
    viewedFileIdsBySection: {},
  };
}

function makeInput(reviewCache = makeReviewCache()) {
  return {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    reviewCache,
  };
}

function renderSections(input: Parameters<typeof useReviewSections>[0]) {
  const result = useReviewSections(input);
  const effects = state.effects.splice(0);
  effects.forEach((effect) => effect());
  return result;
}

it("hides cached local diffs after file access is lost while retaining checkpoint diffs", () => {
  const input = makeInput();
  expect(renderSections(input).selectedSection?.diff).toBe(localDiff);

  state.session = { authenticated: true, scopes: [] };
  const denied = renderSections(input);
  expect(denied.reviewSections.map((section) => section.id)).toEqual(["turn:1"]);
  expect(denied.selectedSection?.diff).toBe(checkpointDiff);

  expect(setReviewSelectedSectionId).toHaveBeenCalledWith("environment:thread", "turn:1");
});

it.each(["working-tree", "branch-range"] as const)(
  "preserves a cached %s selection while an expired grant reloads",
  (kind) => {
    const input = makeInput(makeReviewCache(kind));
    expect(renderSections(input).selectedSection?.diff).toBe(localDiff);

    state.session = null;
    const pending = renderSections(input);
    expect(pending.selectedSection).toEqual(
      expect.objectContaining({ id: `git:${kind}`, diff: null, isLoading: true }),
    );
    expect(pending.loadingGitDiffs).toBe(true);
    expect(pending.reviewSections.find((section) => section.id === "turn:1")?.diff).toBe(
      checkpointDiff,
    );
    expect(setReviewSelectedSectionId).not.toHaveBeenCalled();

    state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
    expect(renderSections(input).selectedSection).toEqual(
      expect.objectContaining({ id: `git:${kind}`, diff: localDiff, isLoading: false }),
    );
    expect(setReviewSelectedSectionId).not.toHaveBeenCalled();
  },
);

it("falls back to a checkpoint when a pending grant resolves without file access", () => {
  const input = makeInput();
  state.session = null;
  renderSections(input);
  expect(setReviewSelectedSectionId).not.toHaveBeenCalled();

  state.session = { authenticated: true, scopes: [] };
  const denied = renderSections(input);
  expect(denied.reviewSections.map((section) => section.id)).toEqual(["turn:1"]);
  expect(denied.selectedSection?.diff).toBe(checkpointDiff);
  expect(setReviewSelectedSectionId).toHaveBeenCalledWith("environment:thread", "turn:1");
});

it("reports a failed access check when no checkpoint can replace the local review", () => {
  state.checkpoints = [];
  const input = makeInput();
  expect(renderSections(input).selectedSection?.diff).toBe(localDiff);

  state.sessionError = "The session request timed out.";
  const unavailable = renderSections(input);
  expect(unavailable.selectedSection).toBeNull();
  expect(unavailable.reviewSections).toEqual([]);
  expect(unavailable.error).toBe(state.sessionError);
});

it("reports denied file access when no checkpoint can replace the local review", () => {
  state.checkpoints = [];
  const input = makeInput();
  expect(renderSections(input).selectedSection?.diff).toBe(localDiff);

  state.session = { authenticated: true, scopes: [] };
  const denied = renderSections(input);
  expect(denied.selectedSection).toBeNull();
  expect(denied.reviewSections).toEqual([]);
  expect(denied.loadingGitDiffs).toBe(false);
  expect(denied.error).toBe("This connection cannot read local diffs.");
});

it("keeps a cached checkpoint available when the filesystem access check fails", () => {
  state.sessionError = "The session request timed out.";
  const checkpoint = renderSections(makeInput());
  expect(checkpoint.selectedSection?.diff).toBe(checkpointDiff);
  expect(checkpoint.error).toBeNull();
});

it("opens the requested historical checkpoint instead of the cached git selection", () => {
  state.checkpoints = [
    state.checkpoints[0]!,
    {
      ...state.checkpoints[0]!,
      runId: RunId.make("turn-2"),
      checkpointTurnCount: 2,
    },
  ];
  const input = makeInput();
  const result = renderSections({ ...input, initialCheckpointTurnCount: 1 });
  expect(result.selectedSection?.id).toBe("turn:1");
  expect(state.diffInputs.at(-1)).toMatchObject({ fromTurnCount: 0, toTurnCount: 1 });
  expect(setReviewSelectedSectionId).toHaveBeenCalledWith("environment:thread", "turn:1");
});

it("keeps the cached selection when the requested checkpoint is unavailable", () => {
  const result = renderSections({ ...makeInput(), initialCheckpointTurnCount: 99 });
  expect(result.selectedSection?.id).toBe("git:working-tree");
  expect(setReviewSelectedSectionId).not.toHaveBeenCalled();
});

it("selects a requested checkpoint when delayed thread data arrives", () => {
  const checkpoints = state.checkpoints;
  state.checkpoints = [];
  const input = { ...makeInput(), initialCheckpointTurnCount: 1 };
  expect(renderSections(input).selectedSection?.id).toBe("git:working-tree");
  state.checkpoints = checkpoints;
  expect(renderSections(input).selectedSection?.id).toBe("turn:1");
});

it("allows a later manual selection after the initial route scope is consumed", () => {
  const input = makeInput();
  expect(renderSections({ ...input, initialCheckpointTurnCount: 1 }).selectedSection?.id).toBe(
    "turn:1",
  );
  expect(renderSections(input).selectedSection?.id).toBe("git:working-tree");
});
