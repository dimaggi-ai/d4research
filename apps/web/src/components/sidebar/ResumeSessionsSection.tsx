import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ResumableSession,
  type ScopedProjectRef,
} from "@d4research/contracts";
import { createModelSelection } from "@d4research/shared/model";
import { resolveProjectSettings } from "@d4research/shared/projectSettings";
import { ChevronRight, History, LoaderCircle, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useNowMinute } from "../../hooks/useNowMinute";

import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { cn, newThreadId } from "../../lib/utils";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";

interface ResumeSessionsSectionProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectRef: ScopedProjectRef;
}

function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diff = Math.max(0, now - then);
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months}mo` : `${Math.round(months / 12)}y`;
}

function ResumeSessionsList({ environmentId, cwd, projectRef }: ResumeSessionsSectionProps) {
  const query = useEnvironmentQuery(
    projectEnvironment.listResumableSessions({ environmentId, input: { cwd } }),
  );
  const createThread = useOrchestrationCommand(threadEnvironment.create);
  const router = useRouter();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [resuming, setResuming] = useState(false);
  const now = Date.parse(`${useNowMinute()}:00Z`);

  const handleResume = async (session: ResumableSession) => {
    if (resuming) return;
    const provider = config?.providers.find(
      (entry) => entry.instanceId === session.providerInstanceId,
    );
    const model =
      (provider?.models.some((entry) => entry.slug === session.model) ? session.model : null) ??
      provider?.models.find((entry) => entry.isDefault)?.slug ??
      provider?.models[0]?.slug;
    if (!model) {
      toastManager.add({ type: "error", title: "No model available for this session's provider" });
      return;
    }
    setResuming(true);
    try {
      const threadId = newThreadId();
      const result = await createThread({
        environmentId,
        input: {
          threadId,
          projectId: projectRef.projectId,
          title: session.title,
          modelSelection: createModelSelection(session.providerInstanceId, model),
          runtimeMode: resolveProjectSettings(
            config?.settings ?? DEFAULT_SERVER_SETTINGS,
            projectRef.projectId,
          ).settings.defaultRuntimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          importedNativeThread: {
            ref: { driver: session.provider, nativeId: session.sessionId, strength: "strong" },
          },
        },
      });
      if (result._tag !== "Success") return;
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
      });
      toastManager.add({
        type: "info",
        title: `Continuing ${session.providerLabel} session`,
        description: "Send a message to pick up where it left off.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open the resumed session",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setResuming(false);
    }
  };

  if (query.isPending && query.data === null) {
    return (
      <div className="flex h-6 items-center gap-2 px-2 text-3xs text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" /> Scanning sessions…
      </div>
    );
  }
  if (query.error && query.data === null) {
    return <div className="px-2 py-1 text-3xs text-destructive">{query.error}</div>;
  }
  const sessions = query.data?.sessions ?? [];
  if (sessions.length === 0) {
    return (
      <div className="px-2 py-1 text-3xs text-muted-foreground">No CLI sessions for this repo</div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {sessions.map((session) => (
        <Tooltip key={session.key}>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="group/resume flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent"
                aria-label={`Continue ${session.providerLabel} session — ${session.title}`}
                disabled={resuming}
                onClick={() => void handleResume(session)}
              />
            }
          >
            <RotateCcw className="size-3 shrink-0 text-muted-foreground group-hover/resume:text-foreground" />
            <span className="min-w-0 flex-1 truncate text-2xs text-foreground">
              {session.title}
            </span>
            <span className="flex shrink-0 items-center gap-1 text-[9px]">
              {session.status === "active" ? (
                <span
                  className="size-1.5 rounded-full bg-emerald-500"
                  aria-label="recently active"
                />
              ) : null}
              <span className="font-medium text-foreground/75">{session.providerLabel}</span>
              <span className="text-muted-foreground">·</span>
              <span className="tabular-nums text-foreground/60">
                {relativeTime(session.updatedAt, now)}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipPopup side="right">
            Continue {session.providerLabel} session — {session.title}
          </TooltipPopup>
        </Tooltip>
      ))}
    </div>
  );
}

/**
 * Collapsible per-project list of resumable Claude/Codex CLI sessions discovered on disk. Querying
 * scans the provider session stores, so the list mounts (and scans) only once the user expands it.
 */
export function ResumeSessionsSection(props: ResumeSessionsSectionProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mx-0.5 mt-0.5 flex flex-col px-1 sm:mx-1 sm:px-1.5">
      <button
        type="button"
        className="flex h-6 w-full items-center gap-1.5 rounded px-2 text-left text-3xs font-medium uppercase tracking-wide text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        <History className="size-3 shrink-0" />
        <span>Resume from CLI</span>
      </button>
      {open ? <ResumeSessionsList {...props} /> : null}
    </div>
  );
}
