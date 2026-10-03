import * as Option from "effect/Option";
import type { EnvironmentThreadShell } from "@d4research/client-runtime/state/shell";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type AssetCreateUrlInput,
  type AssetCreateUrlResult,
  type ChatFileAttachment,
  type CommandId,
  type EnvironmentId,
  isProviderDriverKind,
  ProjectId,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2ProjectedTurnItem,
  type PreviewAnnotationPayload,
  type ProviderInteractionMode,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadContextRecord,
  type ThreadId,
  type ThreadLinkedPullRequest,
  type RunId,
  type WorktreeSetupSnapshot,
} from "@d4research/contracts";
import { worktreeSetupAgentStarted } from "@d4research/client-runtime/worktree-setup";
import * as DateTime from "effect/DateTime";
import { parseScopedThreadKey } from "@d4research/client-runtime/environment";
import { resolveAssetUrl } from "@d4research/client-runtime/state/assets";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@d4research/client-runtime/state/runtime";
import { videoMimeType } from "@d4research/shared/video";
import {
  appendCodexArtifactTemplateUsePrompt,
  codexArtifactTemplateUsePrompt,
  type CodexArtifactTemplate,
} from "@d4research/client-runtime/codex-artifact-templates";
import { presentThreadShell } from "@d4research/client-runtime/state/shell";
import {
  type ChatMessage,
  isImageAttachment,
  type SessionPhase,
  type Thread,
  type TurnDiffSummary,
} from "../types";
import { type ComposerImageAttachment, type DraftThreadState } from "../composerDraftStore";
import * as Schema from "effect/Schema";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells, environmentThreadDetails } from "../state/threads";
import { waitForAtomValue } from "../state/waitForAtomValue";
import { filterTerminalContextsWithText, type TerminalContextDraft } from "../lib/terminalContext";
import { stripInlineContextReferences } from "~/lib/composerContextReferences";
import type { DraftThreadEnvMode } from "../composerDraftStore";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@d4research/contracts";
import { collapseExpandedComposerCursor, type ComposerSubmissionIntent } from "../composer-logic";
import { isDevPipelinePrompt } from "../devPipeline";
import { extractMarkdownLinkHrefs, resolveMarkdownFileLinkMeta } from "../markdown-links";
import { type PreviewMiniPlayerSource } from "../previewMiniPlayerStore";
import { type DesktopPreviewOverlay } from "../previewStateStore";
import {
  NO_PROVIDER_MODEL_SELECTION,
  resolveSelectableProviderInstanceEntry,
  type ProviderInstanceEntry,
} from "../providerInstances";
import {
  buildImmediateProviderHandoffMessage,
  isProviderHandoffCandidate,
  shouldHandoffModelSelection,
} from "../providerHandoff";
import { isDeepResearchPrompt } from "../researchPipeline";
import { type ReviewCommentContext } from "../reviewCommentContext";
import { type RightPanelSurface } from "../rightPanelStore";
import { type TimelineEntry } from "../session-logic";
import { type ThreadShell } from "../types";

/** The floating player hides only while the same source is rendered in the panel. */

interface ProactivePanelObservation {
  threadKey: string;
  runningTurnId: RunId | null | undefined;
  targetKey: string | null | undefined;
  userActionTurnId: RunId | null;
  userActionRevision: number;
}

/** Capture user intent before loading or metadata writes can defer panel activation. */
export function observeProactivePanelUserChoice(
  previous: ProactivePanelObservation | null,
  input: { threadKey: string; runningTurnId: RunId | null; userActionRevision: number },
): ProactivePanelObservation {
  const sameThread = previous?.threadKey === input.threadKey;
  const newTurn =
    sameThread && input.runningTurnId !== null && input.runningTurnId !== previous.userActionTurnId;
  return {
    threadKey: input.threadKey,
    runningTurnId: sameThread ? previous.runningTurnId : undefined,
    targetKey: sameThread ? previous.targetKey : undefined,
    userActionTurnId: input.runningTurnId ?? (sameThread ? previous.userActionTurnId : null),
    userActionRevision:
      !sameThread || newTurn ? input.userActionRevision : previous.userActionRevision,
  };
}

/** Follow a changed server link only when the panel still shows the previous linked PR. */
export function shouldRetargetThreadPullRequestPanel(
  previous: ThreadLinkedPullRequest | null,
  current: ThreadLinkedPullRequest | null,
  surface: RightPanelSurface | null,
): boolean {
  if (previous === null || current === null || surface?.kind !== "pull-request") return false;
  const previousRepository = previous.repository.toLowerCase();
  return (
    (previous.projectId !== current.projectId ||
      previousRepository !== current.repository.toLowerCase() ||
      previous.number !== current.number) &&
    surface.projectId === previous.projectId &&
    surface.repository.toLowerCase() === previousRepository &&
    surface.number === previous.number
  );
}

export function shouldOpenProactiveTurnDiff(input: {
  previousRunningTurnId: RunId | null | undefined;
  runningTurnId: RunId | null;
  settledTurnId: RunId | null;
  turnCompleted: boolean;
}): boolean {
  return (
    input.runningTurnId === null &&
    input.turnCompleted &&
    input.settledTurnId !== null &&
    (input.previousRunningTurnId === undefined ||
      input.settledTurnId === input.previousRunningTurnId)
  );
}
export function resolveProactiveTurnDiffAction(input: {
  checkpoint: Pick<TurnDiffSummary, "status" | "files"> | undefined;
  isGitRepo: boolean | undefined;
  activeSurfaceKind: RightPanelSurface["kind"] | null;
}): "defer" | "ignore" | "open" {
  if (input.activeSurfaceKind === "pull-request") return "ignore";
  if (input.checkpoint === undefined || input.checkpoint.status === "missing") return "defer";
  if (input.isGitRepo === undefined) return "defer";
  if (
    !input.isGitRepo ||
    input.checkpoint.status !== "ready" ||
    input.checkpoint.files.length === 0
  ) {
    return "ignore";
  }
  const changedLines = input.checkpoint.files.reduce(
    (total, file) => total + file.additions + file.deletions,
    0,
  );
  return input.checkpoint.files.length >= 3 || changedLines >= 50 ? "open" : "ignore";
}

export function codexArtifactTemplatePromptToAppend(
  currentDraft: string,
  template: CodexArtifactTemplate,
): string | null {
  return appendCodexArtifactTemplateUsePrompt(currentDraft, template) === currentDraft
    ? null
    : codexArtifactTemplateUsePrompt(template);
}

export function resolveEffectiveInteractionMode(input: {
  planModeEnabled: boolean;
  composerInteractionMode: ProviderInteractionMode | null;
  threadInteractionMode: ProviderInteractionMode | null | undefined;
}): ProviderInteractionMode {
  if (!input.planModeEnabled) return "default";
  return input.composerInteractionMode ?? input.threadInteractionMode ?? "default";
}

export function shouldDockDraftHeroForSubmission(input: {
  isDraftHeroState: boolean;
  activeThreadKey: string | null;
  submissionIntent: ComposerSubmissionIntent;
}): boolean {
  return (
    input.submissionIntent === "foreground" &&
    input.isDraftHeroState &&
    input.activeThreadKey !== null
  );
}

export function shouldReleaseTimelineAnchorForToolActivity(input: {
  anchorMessageId: MessageId | null;
  liveFollowEnabled: boolean;
  runningTurnId: RunId | null;
  timelineEntries: ReadonlyArray<TimelineEntry>;
}): boolean {
  if (input.anchorMessageId === null || !input.liveFollowEnabled || input.runningTurnId === null) {
    return false;
  }

  return input.timelineEntries.some((timelineEntry) => {
    if (timelineEntry.kind !== "work" || timelineEntry.entry.runId !== input.runningTurnId) {
      return false;
    }

    const entry = timelineEntry.entry;
    return (
      entry.tone === "tool" ||
      entry.itemType !== undefined ||
      entry.requestKind !== undefined ||
      (entry.command?.trim().length ?? 0) > 0
    );
  });
}

export {
  findRecordedWorktreeSetup,
  resolveVisibleWorktreeSetup,
} from "@d4research/client-runtime/worktree-setup";

/** Keep setup visible across local dispatch, durable preparation, and the live stream. */
export function resolveWorktreeSetupProgress(input: {
  threadId: ThreadId;
  localPreparing: boolean;
  runStatus: NonNullable<Thread["latestRun"]>["status"] | undefined;
  latest: WorktreeSetupSnapshot | null | undefined;
  held: WorktreeSetupSnapshot | null;
}) {
  const latest = input.latest?.threadId === input.threadId ? input.latest : null;
  const held = input.held?.threadId === input.threadId ? input.held : null;
  const snapshot = latest && (!held || latest.sequence >= held.sequence) ? latest : held;
  return {
    snapshot,
    isPreparingWorktree:
      input.localPreparing ||
      input.runStatus === "preparing" ||
      (snapshot?.phase === "running" && !worktreeSetupAgentStarted(snapshot)),
  };
}

export function resolveDraftHeroState(input: {
  isLocalDraftThread: boolean;
  hasTimelineEntries: boolean;
  isWorking: boolean;
  draftHeroDockRequested: boolean;
  backgroundSubmissionPending: boolean;
  /** A worktree setup card is on the timeline, so the timeline must stay visible. */
  hasWorktreeSetupCard?: boolean;
}): boolean {
  if (input.hasWorktreeSetupCard) {
    return false;
  }
  if (input.backgroundSubmissionPending) {
    return true;
  }
  return (
    input.isLocalDraftThread &&
    !input.hasTimelineEntries &&
    !input.isWorking &&
    !input.draftHeroDockRequested
  );
}

/**
 * Keep painted timelines on screen across thread jumps. Remounting LegendList
 * (or handing it an empty first paint) punches a hole through the chat pane —
 * white in light mode — so cmd+1/2/3 spam flashes even when the destination
 * is already cached.
 *
 * Stored at module scope because ChatView remounts when the thread route
 * changes (same pattern as the thread-error banner session dismissals).
 * Remember more than the last thread so jumping back to cmd+1 does not show
 * cmd+3's messages, and so a cached destination can paint on the first frame.
 */
export type HeldThreadTimeline<T extends readonly unknown[]> = {
  threadKey: string | null;
  entries: T;
  markdownCwd?: string | null;
  workspaceRoot?: string | null;
};

const MAX_REMEMBERED_THREAD_TIMELINES = 16;

let rememberedThreadTimelines = new Map<string, HeldThreadTimeline<readonly unknown[]>>();

let rememberedThreadTimelineOrder: string[] = [];

let lastReadyThreadKey: string | null = null;

function rememberThreadTimelineEntries(held: HeldThreadTimeline<readonly unknown[]>): void {
  if (held.threadKey === null) {
    return;
  }
  rememberedThreadTimelines.set(held.threadKey, held);
  rememberedThreadTimelineOrder = [
    ...rememberedThreadTimelineOrder.filter((key) => key !== held.threadKey),
    held.threadKey,
  ];
  while (rememberedThreadTimelineOrder.length > MAX_REMEMBERED_THREAD_TIMELINES) {
    const evicted = rememberedThreadTimelineOrder.shift();
    if (evicted !== undefined) {
      rememberedThreadTimelines.delete(evicted);
    }
  }
  lastReadyThreadKey = held.threadKey;
}

export function rememberReadyThreadTimeline<T extends readonly unknown[]>(
  held: HeldThreadTimeline<T>,
): void {
  if (held.threadKey === null || held.entries.length === 0) {
    return;
  }
  rememberThreadTimelineEntries(held);
}

export function peekRememberedThreadTimeline<T extends readonly unknown[]>(
  threadKey: string | null,
): T | null {
  if (threadKey === null) {
    return null;
  }
  return (rememberedThreadTimelines.get(threadKey)?.entries as T | undefined) ?? null;
}

export function peekHeldThreadTimeline<
  T extends readonly unknown[],
>(): HeldThreadTimeline<T> | null {
  if (lastReadyThreadKey === null) {
    return null;
  }
  const held = rememberedThreadTimelines.get(lastReadyThreadKey);
  if (held === undefined || held.entries.length === 0) {
    return null;
  }
  return held as HeldThreadTimeline<T>;
}

export function resetHeldThreadTimeline(): void {
  rememberedThreadTimelines = new Map();
  rememberedThreadTimelineOrder = [];
  lastReadyThreadKey = null;
}

export function threadKeysShareEnvironment(left: string | null, right: string | null): boolean {
  if (left === null || right === null) {
    return false;
  }
  const leftRef = parseScopedThreadKey(left);
  const rightRef = parseScopedThreadKey(right);
  return leftRef !== null && rightRef !== null && leftRef.environmentId === rightRef.environmentId;
}

/** True while we still paint another thread's last snapshot. */
export function isPaintOnlyThreadTimeline(
  displayThreadKey: string | null,
  activeThreadKey: string | null,
): boolean {
  return (
    displayThreadKey !== null && activeThreadKey !== null && displayThreadKey !== activeThreadKey
  );
}

export function resolveThreadSwitchTimeline<T extends readonly unknown[]>(input: {
  loading: boolean;
  activeThreadKey: string | null;
  nextEntries: T;
  rememberedForActive?: T | null;
  lastReady?: HeldThreadTimeline<T> | null;
}): { entries: T; displayThreadKey: string | null } {
  if (input.nextEntries.length > 0) {
    return { entries: input.nextEntries, displayThreadKey: input.activeThreadKey };
  }

  const rememberedForActive =
    input.rememberedForActive ?? peekRememberedThreadTimeline<T>(input.activeThreadKey);
  if (input.loading && rememberedForActive !== null && rememberedForActive.length > 0) {
    return { entries: rememberedForActive, displayThreadKey: input.activeThreadKey };
  }

  const lastReady = input.lastReady ?? peekHeldThreadTimeline<T>();
  if (
    input.loading &&
    lastReady !== null &&
    lastReady.threadKey !== null &&
    lastReady.threadKey !== input.activeThreadKey &&
    lastReady.entries.length > 0 &&
    threadKeysShareEnvironment(lastReady.threadKey, input.activeThreadKey)
  ) {
    return { entries: lastReady.entries, displayThreadKey: lastReady.threadKey };
  }
  return { entries: input.nextEntries, displayThreadKey: input.activeThreadKey };
}

export function resolveDraftPromotionNavigationTarget(input: {
  serverThreadRef: ScopedThreadRef | null;
  serverThread: Pick<Thread, "latestRun" | "latestUserMessageAt"> | null | undefined;
  backgroundSubmissionPending: boolean;
}): ScopedThreadRef | null {
  if (input.backgroundSubmissionPending) {
    return null;
  }
  const latestRun = input.serverThread?.latestRun ?? null;
  const runStarted = latestRun?.startedAt != null;
  const startupStopped =
    latestRun?.status === "failed" ||
    latestRun?.status === "interrupted" ||
    latestRun?.status === "cancelled";
  // Like main, promote once the server owns the send. The shared chat view
  // keeps the optimistic message and setup progress mounted through the route swap.
  const messagePersisted = input.serverThread?.latestUserMessageAt != null;
  return runStarted || startupStopped || messagePersisted ? input.serverThreadRef : null;
}

export async function resolveFileAttachmentUrl(input: {
  attachment: ChatFileAttachment;
  environmentId: EnvironmentId;
  httpBaseUrl: string;
  createAssetUrl: (input: {
    environmentId: EnvironmentId;
    input: AssetCreateUrlInput;
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, unknown>>;
}): Promise<string> {
  const { attachment } = input;
  const result = await input.createAssetUrl({
    environmentId: input.environmentId,
    input: {
      resource: {
        _tag: "attachment",
        attachmentId: attachment.id,
        fileName: attachment.name,
        mimeType: videoMimeType(attachment) ?? attachment.mimeType,
      },
    },
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  const url = resolveAssetUrl(input.httpBaseUrl, result.value.relativeUrl);
  if (url === null) throw new Error("The environment returned an invalid attachment URL.");
  return url;
}

export async function prepareRevertedMessageAttachments(input: {
  message: ChatMessage;
  environmentId: EnvironmentId;
  httpBaseUrl: string;
  createAssetUrl: Parameters<typeof resolveFileAttachmentUrl>[0]["createAssetUrl"];
}): Promise<File[]> {
  return Promise.all(
    (input.message.attachments ?? []).map(async (attachment) => {
      if (attachment.type !== "image" && attachment.type !== "file") {
        throw new Error("This message has an attachment that cannot be restored.");
      }
      const result = await input.createAssetUrl({
        environmentId: input.environmentId,
        input: {
          resource: {
            _tag: "attachment",
            attachmentId: attachment.id,
            fileName: attachment.name,
            mimeType: attachment.mimeType,
          },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const url = resolveAssetUrl(input.httpBaseUrl, result.value.relativeUrl);
      if (url === null) throw new Error("The environment returned an invalid attachment URL.");
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Could not restore attachment: ${attachment.name}`);
      return new File([await response.blob()], attachment.name, { type: attachment.mimeType });
    }),
  );
}

export function resolveBackgroundDraftWorkspaceOptions(input: {
  envMode: DraftThreadEnvMode;
  branch: string | null;
  startFromOrigin: boolean;
}): {
  envMode: DraftThreadEnvMode;
  branch: string | null;
  worktreePath: null;
  startFromOrigin: boolean;
} {
  return {
    envMode: input.envMode,
    branch: input.branch,
    worktreePath: null,
    startFromOrigin: input.envMode === "worktree" && input.startFromOrigin,
  };
}

export function shouldShowPlanFollowUpPrompt(input: {
  pendingUserInputCount: number;
  interactionMode: ProviderInteractionMode;
  latestTurnSettled: boolean;
  hasActionableProposedPlan: boolean;
  hasComposerAttachments: boolean;
}): boolean {
  return (
    input.pendingUserInputCount === 0 &&
    input.interactionMode === "plan" &&
    input.latestTurnSettled &&
    input.hasActionableProposedPlan &&
    !input.hasComposerAttachments
  );
}

export function shouldRefocusComposerOnWindowFocus(
  activeElement:
    | (Pick<Element, "tagName" | "closest" | "getAttribute"> & { isContentEditable?: boolean })
    | null,
): boolean {
  if (activeElement === null || activeElement.tagName === "BODY") return true;
  if (
    activeElement.tagName === "INPUT" ||
    activeElement.tagName === "TEXTAREA" ||
    activeElement.tagName === "SELECT" ||
    activeElement.tagName === "IFRAME" ||
    activeElement.tagName === "WEBVIEW" ||
    activeElement.isContentEditable === true ||
    activeElement.getAttribute("role") === "textbox"
  ) {
    return false;
  }
  return (
    activeElement.closest(
      '[role="dialog"], [role="alertdialog"], [data-slot$="-popup"], [data-terminal-owner]',
    ) === null
  );
}

export interface PlanFollowUpComposerSnapshot {
  readonly prompt: string;
  readonly terminalContexts: ReadonlyArray<TerminalContextDraft>;
  readonly reviewComments: ReadonlyArray<ReviewCommentContext>;
  readonly previewAnnotations: ReadonlyArray<PreviewAnnotationPayload>;
  readonly threadContexts?: ReadonlyArray<ThreadContextRecord>;
}

/**
 * Puts back everything a plan follow-up send cleared when the send fails. The
 * caller clears the composer before awaiting the send, so every field it held
 * has to be written back here: a dropped field silently discards user context.
 */
export function restorePlanFollowUpComposer(input: {
  readonly snapshot: PlanFollowUpComposerSnapshot;
  readonly writePrompt: (prompt: string) => void;
  readonly writeTerminalContexts: (contexts: ReadonlyArray<TerminalContextDraft>) => void;
  readonly writeReviewComments: (comments: ReadonlyArray<ReviewCommentContext>) => void;
  readonly writePreviewAnnotations: (annotations: ReadonlyArray<PreviewAnnotationPayload>) => void;
  readonly writeThreadContexts?: (records: ReadonlyArray<ThreadContextRecord>) => void;
  readonly resetCursor: (options: {
    cursor: number;
    prompt: string;
    detectTrigger: boolean;
  }) => void;
}): void {
  input.writePrompt(input.snapshot.prompt);
  input.writeTerminalContexts(input.snapshot.terminalContexts);
  input.writeReviewComments(input.snapshot.reviewComments);
  input.writePreviewAnnotations(input.snapshot.previewAnnotations);
  input.writeThreadContexts?.(input.snapshot.threadContexts ?? []);
  input.resetCursor({
    cursor: collapseExpandedComposerCursor(input.snapshot.prompt, input.snapshot.prompt.length),
    prompt: input.snapshot.prompt,
    detectTrigger: true,
  });
}

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";

export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;

export const MAX_HIDDEN_MOUNTED_PREVIEW_THREADS = 3;

export const ENVIRONMENT_RECONNECT_WARNING_GRACE_MS = 2_000;

// Dismissed research progress banners, persisted so a completed run's banner
// stays closed across reloads. Keyed by `threadId:planTurnId`; a new run mints
// a new plan turn and therefore a new, undismissed key.
export const DISMISSED_RESEARCH_BANNERS_KEY = "t3code:dismissed-research-banners";

export const EMPTY_DISMISSED_RESEARCH_BANNERS: ReadonlyArray<string> = [];

export type ThreadPipelineKind = "research" | "dev";

/**
 * The pipeline progress surface belongs to the turn that is actually running,
 * not to any pipeline prompt ever typed in the thread. A pipeline is armed by a
 * `!dev`/`#deep-research` user prompt, and that prompt carries the turnId of the
 * turn it starts. Scoping to the active turn keeps a stale prompt from an
 * earlier — or already completed — turn from lighting the "Building" banner
 * while an ordinary turn runs. A genuine provider handoff continues the same
 * running turn, so its turnId is unchanged and the banner is retained. Steering
 * messages added mid-run are ordinary text but share the running turn's turnId,
 * so matching any pipeline prompt within the turn stays robust to them. This
 * mirrors the server's per-turn `isPipelineOrchestratorTurn`.
 */
export function deriveThreadPipelineKind(
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "text" | "runId">>,
  activeTurnId: RunId | null,
): ThreadPipelineKind | null {
  if (activeTurnId === null) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user" || message.runId !== activeTurnId) continue;
    if (isDevPipelinePrompt(message.text)) return "dev";
    if (isDeepResearchPrompt(message.text)) return "research";
  }
  return null;
}

export function agentControlledBrowserCloseConfirmation(
  surfaces: readonly RightPanelSurface[],
  desktopByTabId: Readonly<Record<string, Pick<DesktopPreviewOverlay, "controller"> | undefined>>,
): string | null {
  const activeBrowserCount = surfaces.filter(
    (surface) =>
      surface.kind === "preview" &&
      surface.resourceId !== null &&
      desktopByTabId[surface.resourceId]?.controller === "agent",
  ).length;
  if (activeBrowserCount === 0) return null;
  if (activeBrowserCount === 1) {
    return [
      "Close browser while the agent is using it?",
      "The agent is actively controlling this browser. Closing it may interrupt the current browser action.",
    ].join("\n");
  }
  return [
    `Close ${activeBrowserCount} browsers while the agent is using them?`,
    "The agent is actively controlling these browsers. Closing them may interrupt the current browser actions.",
  ].join("\n");
}

/** The floating player hides only while the same source is rendered in the panel. */
export function shouldRenderPreviewMiniPlayer(
  source: PreviewMiniPlayerSource | null,
  renderedRightPanelSurface: RightPanelSurface | null,
): boolean {
  if (source === null) return false;
  if (source.kind === "browser") {
    return !(
      renderedRightPanelSurface?.kind === "preview" &&
      renderedRightPanelSurface.resourceId === source.tabId
    );
  }
  return !(
    renderedRightPanelSurface?.kind === "device" &&
    renderedRightPanelSurface.target?.hostId === source.hostId &&
    renderedRightPanelSurface.target.deviceId === source.deviceId
  );
}

export function shouldOpenProactivePullRequest(
  previousTargetKey: string | null | undefined,
  targetKey: string | null,
): boolean {
  return targetKey !== null && targetKey !== previousTargetKey;
}

/** Capture user intent before loading or metadata writes can defer panel activation. */

/** Validate the exact provider-bound string before optimistic state clears the draft. */
export function outgoingMessageLengthError(messageText: string): string | null {
  if (messageText.length <= PROVIDER_SEND_TURN_MAX_INPUT_CHARS) return null;
  return `This message is ${messageText.length} characters; the provider limit is ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS}. Shorten the prompt or remove an attached context.`;
}

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export const DismissedResearchBannersSchema = Schema.Array(Schema.String);

// Audio files an agent produced in a thread, surfaced as playable artifacts.
// Removal only hides the artifact from the player (persisted per thread+path);
// the generated file itself stays in the workspace and its checkpoints.
export const DISMISSED_AUDIO_ARTIFACTS_KEY = "t3code:dismissed-audio-artifacts";

export const EMPTY_DISMISSED_AUDIO_ARTIFACTS: ReadonlyArray<string> = [];

export const DismissedAudioArtifactsSchema = Schema.Array(Schema.String);

const AUDIO_ARTIFACT_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "m4a",
  "ogg",
  "oga",
  "aac",
  "flac",
  "opus",
  "weba",
]);

export function isAudioArtifactPath(path: string): boolean {
  const extension = path.split(".").pop()?.toLowerCase();
  return extension !== undefined && AUDIO_ARTIFACT_EXTENSIONS.has(extension);
}

export function audioArtifactDismissKey(threadId: string, path: string): string {
  return `${threadId}::${path}`;
}

export function collectAudioArtifactPaths(
  summaries: ReadonlyArray<Pick<TurnDiffSummary, "files">>,
  messages: ReadonlyArray<Pick<ChatMessage, "role" | "text">>,
  workspaceRoot: string | undefined,
): string[] {
  // A changed sound asset is not a recording delivered to the user. Require
  // an explicit assistant link as well as a checkpoint entry.
  const linkedPaths = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const href of extractMarkdownLinkHrefs(message.text)) {
      const path = resolveMarkdownFileLinkMeta(href, workspaceRoot)?.workspaceRelativePath;
      if (path && isAudioArtifactPath(path)) linkedPaths.add(path);
    }
  }
  const paths = new Set<string>();
  for (const summary of summaries) {
    for (const file of summary.files) {
      if (file.kind === "deleted") paths.delete(file.path);
      else if (linkedPaths.has(file.path)) paths.add(file.path);
    }
  }
  return [...paths];
}

export function hasLiveAgentSession(
  phase: SessionPhase,
  backgroundLiveness: "working" | "monitoring" | null | undefined,
): boolean {
  // Neither a connected provider nor a new parent turn revives old children.
  // The server tracks live child work during active and settled parent turns.
  return phase !== "disconnected" && backgroundLiveness != null;
}

/** Delete only a research shell whose first turn was never accepted. */
export function shouldDeleteFailedResearchThread(turnStarted: boolean): boolean {
  return !turnStarted;
}

/** A failed turn may restore its snapshot only when the user has not started another draft. */
export function shouldRestoreComposerSnapshot(input: {
  queuedRequest: boolean;
  promptLength: number;
  imageCount: number;
  terminalContextCount: number;
  elementContextCount: number;
  pastedContextCount: number;
  previewAnnotationCount: number;
  reviewCommentCount: number;
}): boolean {
  return (
    !input.queuedRequest &&
    input.promptLength === 0 &&
    input.imageCount === 0 &&
    input.terminalContextCount === 0 &&
    input.elementContextCount === 0 &&
    input.pastedContextCount === 0 &&
    input.previewAnnotationCount === 0 &&
    input.reviewCommentCount === 0
  );
}

/**
 * Open-in actions are project actions, not Git-only actions. A repository root
 * is preferable when available, but non-Git projects must still be able to
 * open Files/Finder and embedded tools from their workspace root.
 */
export function resolveProjectOpenInCwd(
  gitCwd: string | null | undefined,
  workspaceRoot: string | null | undefined,
): string | null {
  return gitCwd?.trim() || workspaceRoot?.trim() || null;
}

export function scheduleEnvironmentReconnectWarning(showWarning: () => void): () => void {
  const timeoutId = globalThis.setTimeout(showWarning, ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);
  return () => globalThis.clearTimeout(timeoutId);
}

export function hasEnvironmentReconnectWarningGraceElapsed(
  activeEnvironmentId: EnvironmentId | null,
  elapsedEnvironmentId: EnvironmentId | null,
): boolean {
  return activeEnvironmentId !== null && activeEnvironmentId === elapsedEnvironmentId;
}

export function startNewThreadForProject(
  projectRef: ScopedProjectRef | null,
  handleNewThread: (projectRef: ScopedProjectRef) => Promise<unknown>,
): boolean {
  if (projectRef === null) return false;
  void handleNewThread(projectRef);

  return true;
}

export function resolveThreadMetadataUpdateForNextTurn(input: {
  currentModelSelection: ModelSelection;
  nextModelSelection?: ModelSelection;
  currentBranch: string | null;
  nextBranch?: string;
}): {
  modelSelection?: ModelSelection;
  branch?: string;
  worktreePath?: null;
} | null {
  const nextModelSelection = input.nextModelSelection;
  const modelSelectionChanged =
    nextModelSelection !== undefined &&
    (nextModelSelection.model !== input.currentModelSelection.model ||
      nextModelSelection.instanceId !== input.currentModelSelection.instanceId ||
      JSON.stringify(nextModelSelection.options ?? null) !==
        JSON.stringify(input.currentModelSelection.options ?? null));
  const branchChanged = input.nextBranch !== undefined && input.nextBranch !== input.currentBranch;
  if (!modelSelectionChanged && !branchChanged) {
    return null;
  }
  return {
    ...(modelSelectionChanged ? { modelSelection: nextModelSelection } : {}),
    ...(branchChanged ? { branch: input.nextBranch, worktreePath: null } : {}),
  };
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
): Thread {
  const timestamp = DateTime.makeUnsafe(draftThread.createdAt);
  return presentThreadShell(draftThread.environmentId, {
    id: threadId,
    projectId: draftThread.projectId,
    title: "New thread",
    providerInstanceId: fallbackModelSelection.instanceId,
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  });
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  serverThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.serverThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.serverThread.environmentId === input.routeThreadRef.environmentId &&
    input.serverThread.id === input.targetThreadId,
  );
}

/** Use the same enabled instance for the composer, provider status, and chat actions. */
export function resolveComposerProviderSelection(input: {
  entries: ReadonlyArray<ProviderInstanceEntry>;
  candidateInstanceIds: ReadonlyArray<ProviderInstanceId | null | undefined>;
  lockedProvider: ProviderDriverKind | null;
  lockedInstanceId: ProviderInstanceId | null | undefined;
}) {
  const requestedInstanceId = input.candidateInstanceIds.find(
    (candidate) => candidate != null && candidate !== NO_PROVIDER_MODEL_SELECTION.instanceId,
  );
  const requestedDriverKind =
    input.lockedProvider ??
    input.entries.find((entry) => entry.instanceId === requestedInstanceId)?.driverKind ??
    input.entries[0]?.driverKind ??
    ProviderDriverKind.make("unconfigured");
  const lockedContinuationGroupKey = input.lockedProvider
    ? (input.entries.find((entry) => entry.instanceId === input.lockedInstanceId)
        ?.continuationGroupKey ?? null)
    : null;
  // Missing metadata must not move Antigravity history into another Google profile.
  const requiresExactInstance =
    input.lockedProvider === "antigravity" &&
    input.lockedInstanceId != null &&
    lockedContinuationGroupKey === null;
  const compatibleEntries = input.entries.filter(
    (entry) =>
      (!input.lockedProvider || entry.driverKind === input.lockedProvider) &&
      (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey) &&
      (!requiresExactInstance || entry.instanceId === input.lockedInstanceId),
  );
  const selectedProviderEntry =
    input.candidateInstanceIds
      .map((candidate) =>
        compatibleEntries.find(
          (entry) => entry.instanceId === candidate && entry.enabled && entry.isAvailable,
        ),
      )
      .find((entry) => entry !== undefined) ??
    resolveSelectableProviderInstanceEntry(
      compatibleEntries.filter((entry) => entry.driverKind === requestedDriverKind),
      undefined,
    ) ??
    resolveSelectableProviderInstanceEntry(compatibleEntries, undefined);
  const unavailableProviderInstanceId = selectedProviderEntry
    ? undefined
    : input.lockedProvider
      ? (input.lockedInstanceId ?? requestedInstanceId)
      : requestedInstanceId;
  return {
    selectedProviderEntry,
    requestedDriverKind,
    lockedContinuationGroupKey,
    unavailableProviderInstanceId,
  };
}

/** Keep restored drafts and every plan control on the selected instance's supported mode. */
export function resolveComposerInteractionMode(input: {
  planModeEnabled: boolean;
  provider: Pick<ServerProvider, "showInteractionModeToggle"> | null | undefined;
  interactionMode: ProviderInteractionMode;
}): { enabled: boolean; interactionMode: ProviderInteractionMode } {
  const enabled =
    input.planModeEnabled &&
    input.provider != null &&
    input.provider.showInteractionModeToggle !== false;
  return {
    enabled,
    interactionMode: enabled ? input.interactionMode : "default",
  };
}

export function getAntigravitySendBlockReason(
  provider:
    | Pick<ServerProvider, "driver" | "installed" | "auth" | "models" | "status">
    | null
    | undefined,
  model: string,
): string | null {
  if (provider?.driver !== "antigravity") return null;
  if (!provider.installed) {
    return "Install Antigravity in provider settings before sending.";
  }
  if (provider.auth.status === "unauthenticated") {
    return "Sign in to Antigravity in provider settings before sending.";
  }
  const slug = model.trim();
  if (slug.length === 0) return "Choose an Antigravity model before sending.";
  // A restart clears the account status and catalog. Session startup checks
  // saved credentials and validates the model before sending the prompt.
  if (provider.auth.status === "unknown") return null;
  if (provider.models.length === 0) {
    return "Refresh Antigravity models in provider settings before sending.";
  }
  // A saved model that left the catalog is kept in the picker as unavailable
  // so the user sees what the thread used. The server rejects it at turn
  // start, so block here unless the provider is in an error state, where a
  // retry with the same model is the right move.
  if (
    provider.status === "ready" &&
    slug !== ANTIGRAVITY_DEFAULT_MODEL &&
    !provider.models.some((entry) => entry.slug === slug || entry.aliases?.includes(slug))
  ) {
    return "That Antigravity model is no longer available. Choose another model.";
  }
  return null;
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) => threadId !== input.activeThreadId && openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(
    0,
    input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  );
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadTerminalOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (!isImageAttachment(attachment)) {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function timelineHasEphemeralPreviewUrls(
  entries: ReadonlyArray<Pick<TimelineEntry, "kind"> & { message?: ChatMessage }>,
): boolean {
  return entries.some(
    (entry) =>
      entry.kind === "message" &&
      entry.message !== undefined &&
      collectUserMessageBlobPreviewUrls(entry.message).length > 0,
  );
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (!isImageAttachment(attachment)) continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  /**
   * Optional element-pick attachment count. Element contexts contribute to
   * "sendable content" exactly like images and (text-bearing) terminal
   * contexts do: a prompt of just element chips is still a valid send.
   */
  elementContextCount?: number;
  /** Large-paste and dropped-text attachments are independently sendable. */
  pastedContextCount?: number;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineContextReferences(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  const elementContextCount = options.elementContextCount ?? 0;
  const pastedContextCount = options.pastedContextCount ?? 0;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      sendableTerminalContexts.length > 0 ||
      elementContextCount > 0 ||
      pastedContextCount > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function branchMismatchKey(
  threadId: string | null,
  mismatch: { threadBranch: string; currentBranch: string } | null,
): string | null {
  if (!threadId || !mismatch) {
    return null;
  }
  return `${threadId}:${mismatch.threadBranch}:${mismatch.currentBranch}`;
}

// The mismatch banner only matters when the user is about to send: passive
// reading of an old thread carries no risk (the branch picker tint already
// covers ambient awareness). Draft content is the intent signal — composer
// focus is useless here because ChatView autofocuses the composer on every
// thread open. `wasShownForCurrentMismatch` keeps the banner mounted once
// revealed so it doesn't flicker away when the draft is cleared.
export function shouldShowBranchMismatchBanner(input: {
  hasMismatch: boolean;
  isDismissed: boolean;
  composerHasContent: boolean;
  wasShownForCurrentMismatch: boolean;
}): boolean {
  if (!input.hasMismatch || input.isDismissed) {
    return false;
  }
  return input.composerHasContent || input.wasShownForCurrentMismatch;
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes). Durable cross-device dismissal is planned as a server-side ack.
const sessionDismissedBranchMismatchKeys = new Set<string>();

export function dismissBranchMismatchForSession(key: string): void {
  sessionDismissedBranchMismatchKeys.add(key);
}

export function isBranchMismatchDismissedForSession(key: string | null): boolean {
  return key !== null && sessionDismissedBranchMismatchKeys.has(key);
}

// Git status for a checkout arrives after the composer paints, and the branch
// strip mounts on the assumption that a project is a Git repo. Without a
// memory, a non-Git project would mount the strip and drop it on every visit.
// Keyed by environment and checkout for the session; never persisted.
const sessionCheckoutIsRepo = new Map<string, boolean>();

function checkoutIsRepoKey(environmentId: EnvironmentId, cwd: string): string {
  return JSON.stringify([environmentId, cwd]);
}

export function rememberCheckoutIsRepo(
  environmentId: EnvironmentId,
  cwd: string,
  isRepo: boolean,
): void {
  sessionCheckoutIsRepo.set(checkoutIsRepoKey(environmentId, cwd), isRepo);
}

export function recallCheckoutIsRepo(
  environmentId: EnvironmentId,
  cwd: string | null,
): boolean | undefined {
  return cwd === null
    ? undefined
    : sessionCheckoutIsRepo.get(checkoutIsRepoKey(environmentId, cwd));
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(thread && (thread.latestRun !== null || thread.itemCount > 0 || thread.runtime));
}

/**
 * Whether a thread ran at least one turn, judged from its shell alone.
 *
 * `threadHasStarted` needs the detail: a thread whose latest turn was cleared
 * still has messages, and the loading shell carries none. The shell records
 * when the last user message landed, which every started thread has.
 */
export function threadShellHasStarted(
  shell:
    | Pick<EnvironmentThreadShell, "latestRun" | "latestUserMessageAt" | "runtime">
    | null
    | undefined,
): boolean {
  return Boolean(
    shell &&
    (shell.latestRun !== null || shell.latestUserMessageAt !== null || shell.runtime !== null),
  );
}

// Imported history has no session until its first prompt. Resolve its instance
// through the environment's provider catalog before locking to a driver.
export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: string | null;
  threadProvider: string | null;
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>;
}): ProviderDriverKind | null {
  if (!threadHasStarted(input.thread)) {
    return null;
  }
  const sessionProvider = input.thread?.runtime?.providerName ?? null;
  if (sessionProvider && isProviderDriverKind(sessionProvider)) {
    return sessionProvider;
  }
  // Keep the lock when an instance disappears instead of moving imported history
  // to another driver before the user explicitly requests a handoff.
  const threadProvider =
    input.providers.find((provider) => provider.instanceId === input.threadProvider)?.driver ??
    input.threadProvider;
  const selectedProvider =
    input.providers.find((provider) => provider.instanceId === input.selectedProvider)?.driver ??
    input.selectedProvider;
  const narrowedThreadProvider =
    threadProvider && isProviderDriverKind(threadProvider) ? threadProvider : null;
  const narrowedSelectedProvider =
    selectedProvider && isProviderDriverKind(selectedProvider) ? selectedProvider : null;
  return narrowedThreadProvider ?? narrowedSelectedProvider ?? null;
}

/**
 * `requiresNewThreadForModelChange` pins the model of a running provider
 * session. Picking a model on another instance is a handoff: it replaces the
 * session instead of changing its model, so it is never blocked here. The
 * server enforces the same same-instance scope in the provider command
 * reactor; blocking cross-instance picks in the client only hid every handoff
 * into or out of such a provider (Agy, Junie).
 */
export function getStartedThreadModelChangeBlockReason(input: {
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "requiresNewThreadForModelChange">>;
  hasStartedSession: boolean;
  supportsProviderSwitchingViaHandoff?: boolean;
  currentModelSelection: ModelSelection;
  currentProviderInstanceId?: ModelSelection["instanceId"] | null | undefined;
  nextModelSelection: ModelSelection;
}): { title: string; description: string } | null {
  if (!input.hasStartedSession) {
    return null;
  }
  const currentInstanceId =
    input.currentProviderInstanceId ?? input.currentModelSelection.instanceId;
  if (
    currentInstanceId !== input.nextModelSelection.instanceId ||
    input.currentModelSelection.model === input.nextModelSelection.model
  ) {
    return null;
  }
  const currentProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === currentInstanceId,
  );
  if (currentProvider?.requiresNewThreadForModelChange !== true) {
    return null;
  }
  return {
    title: "Start a new chat to change models",
    description: "This provider does not allow switching models after a conversation has started.",
  };
}

/**
 * Whether an outgoing model selection would hand off, and whether its target can
 * actually receive one. `unavailable` exists so the dispatch can refuse: a
 * required handoff whose target is unhealthy must abort, never downgrade to a
 * plain send that switches the provider-native session behind Memo's back.
 */
export type ProviderHandoffResolution =
  | { readonly kind: "none" }
  | { readonly kind: "ready"; readonly target: ModelSelection; readonly displayName: string }
  | { readonly kind: "unavailable"; readonly displayName: string };

export const NO_PROVIDER_HANDOFF: ProviderHandoffResolution = { kind: "none" };

/**
 * The one resolver every send path shares: the composer, the staged-handoff
 * banner, direct sends, and queued sends. `thread` is null for anything that
 * is not a server thread. `entries` are the environment's provider instances
 * with settings applied; `sessionLockedProvider` comes from `deriveLockedProvider`.
 */
export function resolveProviderHandoff(input: {
  readonly thread: Pick<Thread, "runtime" | "modelSelection"> | null | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly sessionLockedProvider: ProviderDriverKind | null;
  readonly nextModelSelection: ModelSelection;
}): ProviderHandoffResolution {
  const { thread, providers, nextModelSelection, sessionLockedProvider } = input;
  if (!thread) return NO_PROVIDER_HANDOFF;
  const currentInstanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  // A session record with no provider name was never a native session:
  // an inline delegation synthesizes one purely to say "this thread is
  // busy". Handing off from a provider that never ran would stage a
  // pointless Memo bridge, so it does not count as started.
  const hasStartedSession = thread.runtime !== null && thread.runtime.providerName !== null;
  const driverKind =
    providers.find((snapshot) => snapshot.instanceId === nextModelSelection.instanceId)?.driver ??
    null;
  // Whether a handoff is REQUIRED is a fact about the thread and the
  // outgoing selection alone. Target health must never soften it: the
  // provider lock only constrains driver kind, so a sibling instance of the
  // running driver would otherwise resolve to "no handoff" and be
  // dispatched plain — switching the native session with no Memo proof.
  const requiresHandoff = shouldHandoffModelSelection({
    hasStartedSession,
    currentInstanceId,
    nextInstanceId: nextModelSelection.instanceId,
    modelChangeRequiresNewThread:
      getStartedThreadModelChangeBlockReason({
        providers,
        hasStartedSession,
        currentModelSelection: thread.modelSelection,
        currentProviderInstanceId: thread.runtime?.providerInstanceId ?? null,
        nextModelSelection,
      }) !== null,
    providerChanged:
      sessionLockedProvider !== null && driverKind !== null && driverKind !== sessionLockedProvider,
  });
  if (!requiresHandoff) return NO_PROVIDER_HANDOFF;

  const entry = input.entries.find(
    (candidate) => candidate.instanceId === nextModelSelection.instanceId,
  );
  const displayName = entry?.displayName ?? String(nextModelSelection.instanceId);
  // Target health decides whether the handoff can happen, not whether one is
  // needed. Staging hides an unhealthy target (the banner would promise a
  // switch the composer silently declines) and the dispatch refuses it.
  // Same-instance model changes skip this: there is no other target to vet.
  const targetUnusable =
    nextModelSelection.instanceId !== currentInstanceId &&
    (!entry || !isProviderHandoffCandidate(entry, currentInstanceId));
  return targetUnusable
    ? { kind: "unavailable", displayName }
    : { kind: "ready", target: nextModelSelection, displayName };
}

/**
 * Wraps an outgoing message in the handoff its resolution requires. Returns
 * null when no handoff applies and `error` when the send must abort: an
 * unavailable target, or a message too long to carry the context.
 */
export function applyProviderHandoffToMessage(input: {
  readonly resolution: ProviderHandoffResolution;
  readonly composedText: string;
  readonly thread: { readonly id: ThreadId; readonly title: string };
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
  readonly projectTitle: string | undefined;
  readonly enabledSkills: ReadonlyArray<string>;
}): { readonly text: string } | { readonly error: string } | null {
  const { resolution } = input;
  if (resolution.kind === "none") return null;
  if (resolution.kind === "unavailable") {
    return { error: `${resolution.displayName} is not available to receive a handoff.` };
  }
  try {
    const text = buildImmediateProviderHandoffMessage({
      promptText: input.composedText,
      messages: input.messages,
      context: {
        sourceThreadId: input.thread.id,
        sourceThreadTitle: input.thread.title,
        targetInstanceId: String(resolution.target.instanceId),
        targetModel: resolution.target.model,
        targetLabel: resolution.displayName,
        project: input.projectTitle,
        enabledSkills: input.enabledSkills,
      },
    });
    const lengthError = outgoingMessageLengthError(text);
    return lengthError !== null ? { error: lengthError } : { text };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The provider handoff failed." };
  }
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const threadAtom = environmentThreadShells.threadShellAtom(threadRef);
  return waitForAtomValue({
    registry: appAtomRegistry,
    atom: threadAtom,
    predicate: threadHasStarted,
    timeoutMs,
  });
}

/**
 * Runs `revert` (the rollback command `requestId`) and resolves once the
 * message's run is rolled back. Rejects with the server's reason as soon as
 * the thread records that this rollback failed.
 */
export async function waitForRevertedMessage(
  threadRef: ScopedThreadRef,
  messageId: MessageId,
  turnCount: number,
  requestId: CommandId,
  revert: () => Promise<void>,
  timeoutMs = 120_000,
): Promise<void> {
  const threadAtom = environmentThreadDetails.stateAtom(threadRef);
  const readProjection = () => Option.getOrNull(appAtomRegistry.get(threadAtom).data);
  const initial = readProjection();
  if (!initial?.messages.some((message) => message.id === messageId)) {
    throw new Error("The message to rewind is no longer available.");
  }
  const messageRunId = initial.messages.find((message) => message.id === messageId)?.runId;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let accepted = false;
    let unsubscribe = () => {};
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      unsubscribe();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const inspect = () => {
      const thread = readProjection();
      if (!thread) return;
      const failure = thread.thread.rollbackFailure;
      if (failure?.requestId === requestId) {
        finish(new Error(failure.message));
        return;
      }
      if (
        accepted &&
        thread.runs.some(
          (run) =>
            run.id === messageRunId && run.ordinal > turnCount && run.status === "rolled_back",
        )
      )
        finish();
    };
    unsubscribe = appAtomRegistry.subscribe(threadAtom, inspect);
    timeout = globalThis.setTimeout(() => {
      finish(new Error("Timed out waiting for the thread to rewind."));
    }, timeoutMs);
    Promise.resolve()
      .then(revert)
      .then(() => {
        accepted = true;
        inspect();
      }, finish);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  submissionIntent: ComposerSubmissionIntent;
  latestUserMessageId: ChatMessage["id"] | null;
  latestRunId: RunId | null;
  latestRunRequestedAt: string | null;
  latestRunStartedAt: string | null;
  latestRunCompletedAt: string | null;
  runtimeStatus: NonNullable<Thread["runtime"]>["status"] | null;
  runtimeUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: {
    preparingWorktree?: boolean;
    latestUserMessageId?: ChatMessage["id"] | null;
    submissionIntent?: ComposerSubmissionIntent;
  },
): LocalDispatchSnapshot {
  const latestRun = activeThread?.latestRun ?? null;
  const runtime = activeThread?.runtime ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    submissionIntent: options?.submissionIntent ?? "foreground",
    latestUserMessageId: options?.latestUserMessageId ?? null,
    latestRunId: latestRun?.runId ?? null,
    latestRunRequestedAt: latestRun?.requestedAt ?? null,
    latestRunStartedAt: latestRun?.startedAt ?? null,
    latestRunCompletedAt: latestRun?.completedAt ?? null,
    runtimeStatus: runtime?.status ?? null,
    runtimeUpdatedAt: runtime?.updatedAt ?? null,
  };
}

/**
 * The timeline renders committed user rows from `visibleTurnItems`, but
 * `message.updated` can land in `projection.messages` one event earlier than
 * the matching `turn-item.updated`. Basing optimistic eviction on visible user
 * turn items avoids dropping steer rows in that gap.
 */
export function deriveCommittedServerUserMessageIds(
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlySet<ChatMessage["id"]> {
  return new Set(
    visibleTurnItems.flatMap((row) =>
      row.item.type === "user_message" ? [row.item.messageId] : [],
    ),
  );
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestRun: Thread["latestRun"] | null;
  latestUserMessageId?: ChatMessage["id"] | null;
  runtime: Thread["runtime"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }
  if (input.phase === "connecting") {
    return false;
  }

  const latestRun = input.latestRun ?? null;
  const runtime = input.runtime ?? null;
  const latestUserMessageChanged =
    input.localDispatch.latestUserMessageId !== (input.latestUserMessageId ?? null);
  const latestRunChanged =
    input.localDispatch.latestRunId !== (latestRun?.runId ?? null) ||
    input.localDispatch.latestRunRequestedAt !== (latestRun?.requestedAt ?? null) ||
    input.localDispatch.latestRunStartedAt !== (latestRun?.startedAt ?? null) ||
    input.localDispatch.latestRunCompletedAt !== (latestRun?.completedAt ?? null);

  if (input.phase === "running") {
    if (latestUserMessageChanged) {
      return true;
    }
    if (!latestRunChanged) {
      return false;
    }
    if (latestRun?.startedAt === null || latestRun === null) {
      return false;
    }
    if (
      runtime?.activeRunId !== null &&
      runtime?.activeRunId !== undefined &&
      latestRun?.runId !== runtime.activeRunId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestRunChanged ||
    input.localDispatch.runtimeStatus !== (runtime?.status ?? null) ||
    input.localDispatch.runtimeUpdatedAt !== (runtime?.updatedAt ?? null)
  );
}

// Returning to the window should land the caret in the composer, so the reader can type right
// away. The exceptions are places where focus is deliberate: another text field, a terminal in
// the drawer or the right panel, or an open dialog or popup. A focused button outside those is
// not one of them, so it yields to the composer.

/**
 * Puts back everything a plan follow-up send cleared when the send fails. The
 * caller clears the composer before awaiting the send, so every field it held
 * has to be written back here: a dropped field silently discards user context.
 */
