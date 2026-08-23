import type { AssetResource, EnvironmentId, ThreadId } from "@d4research/contracts";
import {
  ChevronLeft,
  ChevronRight,
  Pause,
  Play,
  Podcast,
  RotateCcw,
  RotateCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useAssetUrls } from "../../assets/assetUrls";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const PLAYBACK_RATES = [1, 1.25, 1.5, 1.75, 2] as const;
const SKIP_SECONDS = 15;

export function formatPodcastTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function nextPodcastPlaybackRate(
  current: (typeof PLAYBACK_RATES)[number],
): (typeof PLAYBACK_RATES)[number] {
  return PLAYBACK_RATES[(PLAYBACK_RATES.indexOf(current) + 1) % PLAYBACK_RATES.length]!;
}

export function normalizePodcastDuration(duration: number): number {
  return Number.isFinite(duration) && duration >= 0 ? duration : 0;
}

export function clampPodcastTime(time: number, duration: number): number {
  if (!Number.isFinite(time)) return 0;
  return Math.min(Math.max(time, 0), normalizePodcastDuration(duration));
}

function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}

/**
 * Plays audio artifacts an agent generated in the active thread. The player
 * only mounts when `artifacts` is non-empty (ChatView gates it), so a chat with
 * no audio never shows it. Each artifact resolves to a workspace-file asset URL;
 * time updates ride the element's `timeupdate` event rather than a rAF loop, so
 * the player does not repaint continuously.
 */
export function PodcastPlayer(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  /** Workspace-relative paths of audio files produced in this thread. */
  artifacts: ReadonlyArray<string>;
  /** Hide an artifact from the player (does not delete the file). */
  onRemove: (path: string) => void;
  className?: string;
}) {
  const { environmentId, threadId, artifacts, onRemove } = props;
  const resources = useMemo<ReadonlyArray<AssetResource>>(
    () => artifacts.map((path) => ({ _tag: "workspace-file", threadId, path })),
    [artifacts, threadId],
  );
  const urls = useAssetUrls(environmentId, resources);

  return (
    <PodcastPlayerView
      artifacts={artifacts}
      urls={urls}
      onRemove={onRemove}
      {...(props.className !== undefined ? { className: props.className } : {})}
    />
  );
}

/** The transport UI separated from workspace URL resolution for reuse and browser testing. */
export function PodcastPlayerView(props: {
  artifacts: ReadonlyArray<string>;
  urls: ReadonlyArray<string | null>;
  onRemove: (path: string) => void;
  className?: string;
}) {
  const { artifacts, urls, onRemove } = props;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [selected, setSelected] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState<(typeof PLAYBACK_RATES)[number]>(1);

  // Keep the selection in range as artifacts appear or get removed.
  const index = Math.min(selected, Math.max(artifacts.length - 1, 0));
  const currentPath = artifacts[index];
  const currentUrl = urls[index] ?? null;

  // A new track resets the transport; the element reloads via its `key`.
  useEffect(() => {
    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
  }, [currentUrl]);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  }, []);

  const skip = useCallback((delta: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = clampPodcastTime(el.currentTime + delta, el.duration);
  }, []);

  const cycleRate = useCallback(() => {
    setRate((current) => {
      const next = nextPodcastPlaybackRate(current);
      if (audioRef.current) audioRef.current.playbackRate = next;
      return next;
    });
  }, []);

  if (!currentPath) return null;

  return (
    <div
      className={cn(
        "mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 rounded-2xl border border-border bg-card/80 px-3 py-2",
        props.className,
      )}
    >
      <Podcast className="size-4 shrink-0 text-violet-400" />

      {currentUrl ? (
        <audio
          key={currentUrl}
          ref={audioRef}
          src={currentUrl}
          preload="metadata"
          onLoadedMetadata={(event) => {
            event.currentTarget.playbackRate = rate;
            setDuration(normalizePodcastDuration(event.currentTarget.duration));
          }}
          onTimeUpdate={(event) =>
            setCurrentTime(
              clampPodcastTime(event.currentTarget.currentTime, event.currentTarget.duration),
            )
          }
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
        />
      ) : null}

      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        onClick={() => skip(-SKIP_SECONDS)}
        disabled={!currentUrl}
        aria-label={`Back ${SKIP_SECONDS} seconds`}
      >
        <RotateCcw className="size-4" />
      </Button>

      <Button
        variant="default"
        size="icon"
        className="size-9 shrink-0 rounded-full"
        onClick={togglePlay}
        disabled={!currentUrl}
        aria-label={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
      </Button>

      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        onClick={() => skip(SKIP_SECONDS)}
        disabled={!currentUrl}
        aria-label={`Forward ${SKIP_SECONDS} seconds`}
      >
        <RotateCw className="size-4" />
      </Button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1.5">
          {artifacts.length > 1 ? (
            <>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                onClick={() => setSelected(Math.max(index - 1, 0))}
                disabled={index === 0}
                aria-label="Previous audio"
              >
                <ChevronLeft className="size-3.5" />
              </button>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {index + 1}/{artifacts.length}
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground disabled:opacity-40"
                onClick={() => setSelected(Math.min(index + 1, artifacts.length - 1))}
                disabled={index === artifacts.length - 1}
                aria-label="Next audio"
              >
                <ChevronRight className="size-3.5" />
              </button>
            </>
          ) : null}
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            title={currentPath}
          >
            {basename(currentPath)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-9 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
            {formatPodcastTime(currentTime)}
          </span>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.1}
            value={currentTime}
            aria-label="Seek"
            className="h-1 flex-1 cursor-pointer accent-primary"
            onChange={(event) => {
              const value = clampPodcastTime(Number(event.target.value), duration);
              if (audioRef.current) audioRef.current.currentTime = value;
              setCurrentTime(value);
            }}
          />
          <span className="w-9 shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {formatPodcastTime(duration)}
          </span>
        </div>
      </div>

      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-xs tabular-nums"
        onClick={cycleRate}
        aria-label="Playback speed"
      >
        {rate}×
      </Button>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={() => onRemove(currentPath)}
              aria-label="Remove audio artifact"
            >
              <X className="size-4" />
            </Button>
          }
        />
        <TooltipPopup side="top">Remove from player (keeps the file)</TooltipPopup>
      </Tooltip>
    </div>
  );
}
