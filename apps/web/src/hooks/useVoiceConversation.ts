import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ChatMessage } from "../types";

const DEFAULT_VOICE_GATEWAY_URL = "http://127.0.0.1:8093";
const SILENCE_THRESHOLD = 0.025;
const SILENCE_DURATION_MS = 900;
const MIN_SPEECH_DURATION_MS = 250;
// Replies longer than this, or with code or tables, are summarized before speaking; the full
// text stays on screen.
export const SPOKEN_SUMMARY_THRESHOLD_CHARS = 600;
const LEVEL_WINDOW_SECONDS = 0.04;
const SILENT_WAV_DATA_URL =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

export type VoiceConversationStatus =
  | "idle"
  | "listening"
  | "transcribing"
  | "waiting"
  | "summarizing"
  | "speaking";

export const voiceConversationStatusCopy: Record<
  VoiceConversationStatus,
  { label: string; detail: string }
> = {
  idle: { label: "Talk", detail: "Start a hands-free conversation" },
  listening: { label: "Listening", detail: "Speak naturally, then pause" },
  transcribing: { label: "Transcribing", detail: "Turning your voice into text locally" },
  waiting: { label: "Thinking", detail: "Waiting for d4research to reply" },
  summarizing: { label: "Summarizing", detail: "Gemma is making the reply easier to listen to" },
  speaking: { label: "Speaking", detail: "Playing d4research's reply locally" },
};

function voiceGatewayUrl(): string {
  const configured = import.meta.env.VITE_VOICE_GATEWAY_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (window.isSecureContext && location.hostname !== "localhost") return location.origin;
  return DEFAULT_VOICE_GATEWAY_URL;
}

function voiceGatewayUnavailableMessage(): string {
  const configured = import.meta.env.VITE_VOICE_GATEWAY_URL;
  return configured
    ? `Could not reach the configured voice gateway at ${configured}.`
    : "Could not reach the local voice gateway through Caddy. Check the local /voice proxy.";
}

function recordingMimeType(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg", "audio/mp4"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
}

function recordingExtension(mimeType: string): string {
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

function requireSuccessfulResponse(response: Response, message: string): void {
  if (!response.ok) throw new Error(message);
}

export function spokenExcerpt(markdown: string): string {
  const text = speechReadyText(markdown);
  return text
    .split(/(?<=[.!?])\s+/)
    .slice(0, 2)
    .join(" ")
    .slice(0, 360);
}

export function needsSpokenSummary(markdown: string): boolean {
  if (markdown.includes("```")) return true;
  if (/^\s*\|.*\|\s*$/m.test(markdown) && /^\s*\|?\s*:?-{3,}/m.test(markdown)) return true;
  return speechReadyText(markdown).length > SPOKEN_SUMMARY_THRESHOLD_CHARS;
}

/**
 * Loudness per 40 ms window of a 16-bit PCM WAV, normalized to 0..1. The
 * playback level is read from this instead of routing the reply through Web
 * Audio, because a MediaElementSource on iOS goes silent while its context is
 * suspended.
 */
export function wavLevelEnvelope(buffer: ArrayBuffer): Float32Array | null {
  const view = new DataView(buffer);
  if (buffer.byteLength < 44 || view.getUint32(0, false) !== 0x52494646) return null;
  let offset = 12;
  let channels = 1;
  let sampleRate = 0;
  let bitsPerSample = 0;
  while (offset + 8 <= buffer.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 0x666d7420) {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 0x64617461) {
      if (bitsPerSample !== 16 || sampleRate === 0 || channels === 0) return null;
      const end = Math.min(buffer.byteLength, body + size);
      const frameBytes = 2 * channels;
      const windowFrames = Math.max(1, Math.round(sampleRate * LEVEL_WINDOW_SECONDS));
      const frames = Math.floor((end - body) / frameBytes);
      const envelope = new Float32Array(Math.ceil(frames / windowFrames));
      let peak = 0;
      for (let index = 0; index < envelope.length; index += 1) {
        const first = index * windowFrames;
        const last = Math.min(frames, first + windowFrames);
        let sum = 0;
        for (let frame = first; frame < last; frame += 1) {
          const sample = view.getInt16(body + frame * frameBytes, true) / 32768;
          sum += sample * sample;
        }
        const rms = Math.sqrt(sum / Math.max(1, last - first));
        envelope[index] = rms;
        peak = Math.max(peak, rms);
      }
      if (peak > 0) {
        for (let index = 0; index < envelope.length; index += 1) {
          envelope[index] = (envelope[index] ?? 0) / peak;
        }
      }
      return envelope;
    }
    offset = body + size + (size % 2);
  }
  return null;
}

function speechReadyText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/[*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isReadOriginalRequest(transcript: string): boolean {
  const normalized = transcript
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return /\b(read|play|speak)\b.*\b(original|full|whole|verbatim)\b/.test(normalized);
}

export async function summarizeReplyForSpeech(
  markdown: string,
  options: {
    fetcher?: typeof fetch;
    gatewayUrl?: string;
    timeoutMs?: number;
    summarize?: ((markdown: string) => Promise<string | null>) | undefined;
  } = {},
): Promise<string> {
  const fallback = spokenExcerpt(markdown);
  if (!fallback) return "";
  const preferred = await options.summarize?.(markdown).catch(() => null);
  if (preferred?.trim()) return preferred.trim();

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  try {
    const body = new URLSearchParams({ text: markdown.slice(0, 6_000) });
    const response = await (options.fetcher ?? fetch)(
      `${options.gatewayUrl ?? voiceGatewayUrl()}/voice/summarize`,
      { method: "POST", body, signal: controller.signal },
    );
    if (!response.ok) return fallback;
    const result = (await response.json()) as { text?: unknown };
    const summary = typeof result.text === "string" ? result.text.trim() : "";
    return summary || fallback;
  } catch {
    return fallback;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export interface SpokenVoiceReply {
  readonly messageId: string;
  readonly text: string;
  readonly summarized: boolean;
}

export function useVoiceConversation(options: {
  messages: readonly (Pick<ChatMessage, "role" | "text" | "streaming"> & { readonly id: string })[];
  onTranscript: (transcript: string) => boolean;
  onError: (message: string) => void;
  /** Preferred summarizer for long replies; the voice gateway and an excerpt are fallbacks. */
  summarize?: (markdown: string) => Promise<string | null>;
}): {
  active: boolean;
  status: VoiceConversationStatus;
  hasOriginalReply: boolean;
  /** Microphone or playback loudness, 0..1, updated every animation frame without rendering. */
  levelRef: RefObject<number>;
  heard: string | null;
  spoken: SpokenVoiceReply | null;
  toggleConversation: () => void;
  stopConversation: () => void;
} {
  const { messages, onError, onTranscript, summarize } = options;
  const [status, setStatus] = useState<VoiceConversationStatus>("idle");
  const [active, setActive] = useState(false);
  const [hasOriginalReply, setHasOriginalReply] = useState(false);
  const [heard, setHeard] = useState<string | null>(null);
  const [spoken, setSpoken] = useState<SpokenVoiceReply | null>(null);
  const levelRef = useRef(0);
  const playbackFrameRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioEndedHandlerRef = useRef<(() => void) | null>(null);
  const audioErrorHandlerRef = useRef<(() => void) | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const cancelRecordingRef = useRef(false);
  const chunksRef = useRef<Blob[]>([]);
  const pendingAssistantIdsRef = useRef<Set<string> | null>(null);
  const originalReplyRef = useRef<{ id: string; text: string } | null>(null);
  const startListeningRef = useRef<() => Promise<void>>(async () => undefined);

  const stopTracks = () => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const clearPlaybackHandlers = (audio: HTMLAudioElement) => {
    if (audioEndedHandlerRef.current) {
      audio.removeEventListener("ended", audioEndedHandlerRef.current);
      audioEndedHandlerRef.current = null;
    }
    if (audioErrorHandlerRef.current) {
      audio.removeEventListener("error", audioErrorHandlerRef.current);
      audioErrorHandlerRef.current = null;
    }
  };

  const stopPlaybackLevel = () => {
    if (playbackFrameRef.current !== null) cancelAnimationFrame(playbackFrameRef.current);
    playbackFrameRef.current = null;
    levelRef.current = 0;
  };

  const followPlaybackLevel = (audio: HTMLAudioElement, envelope: Float32Array | null) => {
    stopPlaybackLevel();
    const step = () => {
      if (audio.ended || !audio.src) {
        levelRef.current = 0;
        playbackFrameRef.current = null;
        return;
      }
      const index = Math.floor(audio.currentTime / LEVEL_WINDOW_SECONDS);
      levelRef.current = audio.paused
        ? 0
        : envelope
          ? (envelope[index] ?? 0)
          : 0.45 + 0.25 * Math.sin(audio.currentTime * 9);
      playbackFrameRef.current = requestAnimationFrame(step);
    };
    playbackFrameRef.current = requestAnimationFrame(step);
  };

  const stopPlayback = () => {
    stopPlaybackLevel();
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    clearPlaybackHandlers(audio);
    if (audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
    audio.removeAttribute("src");
    audioRef.current = null;
  };

  // iOS only allows delayed playback when an audio element was unlocked by
  // the original tap. Reuse that element for every spoken reply in this
  // conversation instead of creating one after the model finishes.
  const unlockPlayback = () => {
    const audio = new Audio(SILENT_WAV_DATA_URL);
    audio.setAttribute("playsinline", "");
    audioRef.current = audio;
    void audio.play().then(
      () => {
        audio.pause();
        audio.currentTime = 0;
      },
      () => undefined,
    );
  };

  const stopConversation = () => {
    activeRef.current = false;
    setActive(false);
    pendingAssistantIdsRef.current = null;
    cancelRecordingRef.current = true;
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
    recorderRef.current = null;
    chunksRef.current = [];
    stopTracks();
    stopPlayback();
    levelRef.current = 0;
    setStatus("idle");
  };

  const failConversation = (message: string) => {
    stopConversation();
    onError(message);
  };

  const speak = async (reply: { id: string; text: string }, allowSummary = true) => {
    const markdown = reply.text;
    if (!spokenExcerpt(markdown)) {
      if (activeRef.current) void startListeningRef.current();
      return;
    }
    const unlockedAudio = audioRef.current;
    unlockedAudio?.pause();
    const summarized = allowSummary && needsSpokenSummary(markdown);
    if (summarized) {
      originalReplyRef.current = { id: reply.id, text: markdown };
      setHasOriginalReply(true);
      setStatus("summarizing");
    }
    try {
      const text = summarized
        ? await summarizeReplyForSpeech(markdown, { summarize })
        : speechReadyText(markdown).slice(0, 6_000);
      if (!activeRef.current) return;
      setSpoken({ messageId: reply.id, text, summarized });
      setStatus("speaking");
      const body = new URLSearchParams({ text });
      const response = await fetch(`${voiceGatewayUrl()}/voice/tts`, { method: "POST", body });
      requireSuccessfulResponse(response, `Voice gateway returned ${response.status}`);
      const audio = unlockedAudio ?? new Audio();
      const wav = await response.arrayBuffer();
      const objectUrl = URL.createObjectURL(
        new Blob([wav], { type: response.headers.get("content-type") ?? "audio/wav" }),
      );
      audio.src = objectUrl;
      audio.setAttribute("playsinline", "");
      audioRef.current = audio;
      const finish = () => {
        stopPlaybackLevel();
        URL.revokeObjectURL(objectUrl);
        audio.removeAttribute("src");
        clearPlaybackHandlers(audio);
        if (activeRef.current) window.setTimeout(() => void startListeningRef.current(), 300);
      };
      const handleError = () =>
        failConversation("The local voice gateway could not play the reply.");
      audioEndedHandlerRef.current = finish;
      audioErrorHandlerRef.current = handleError;
      audio.addEventListener("ended", finish, { once: true });
      audio.addEventListener("error", handleError, { once: true });
      await audio.play();
      followPlaybackLevel(audio, wavLevelEnvelope(wav));
    } catch {
      failConversation(voiceGatewayUnavailableMessage());
    }
  };

  const expectAssistantReply = () => {
    pendingAssistantIdsRef.current = new Set(
      messages.filter((message) => message.role === "assistant").map((message) => message.id),
    );
  };

  const transcribeRecording = async (audio: Blob, mimeType: string) => {
    if (!activeRef.current) return;
    setStatus("transcribing");
    try {
      const form = new FormData();
      form.append("audio", audio, `voice.${recordingExtension(mimeType)}`);
      const response = await fetch(`${voiceGatewayUrl()}/voice/transcribe`, {
        method: "POST",
        body: form,
      });
      requireSuccessfulResponse(response, `Voice gateway returned ${response.status}`);
      const result = (await response.json()) as { text?: unknown };
      const transcript = typeof result.text === "string" ? result.text.trim() : "";
      if (!transcript) {
        await startListeningRef.current();
        return;
      }
      setHeard(transcript);
      const originalReply = originalReplyRef.current;
      if (originalReply && isReadOriginalRequest(transcript)) {
        void speak(originalReply, false);
        return;
      }
      expectAssistantReply();
      if (!onTranscript(transcript)) {
        stopConversation();
        return;
      }
      setStatus("waiting");
    } catch {
      failConversation(voiceGatewayUnavailableMessage());
    }
  };

  const startListening = async () => {
    if (!activeRef.current || recorderRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!activeRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const preferredMimeType = recordingMimeType();
      const recorder = preferredMimeType
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream);
      const mimeType = recorder.mimeType || preferredMimeType || "audio/webm";
      recorderRef.current = recorder;
      chunksRef.current = [];
      cancelRecordingRef.current = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const cancelled = cancelRecordingRef.current;
        const audio = new Blob(chunksRef.current, { type: mimeType });
        recorderRef.current = null;
        chunksRef.current = [];
        levelRef.current = 0;
        stopTracks();
        if (!cancelled && activeRef.current) void transcribeRecording(audio, mimeType);
      };
      recorder.start(250);
      setStatus("listening");

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      const startedAt = performance.now();
      let heardSpeechAt: number | null = null;
      let lastVoiceAt = startedAt;
      const detectSilence = () => {
        if (recorder.state !== "recording") return;
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(
          samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length,
        );
        const now = performance.now();
        // Speech RMS sits around 0.02-0.2; scale it into the 0..1 range the visuals expect.
        levelRef.current = Math.min(1, rms * 6);
        if (rms >= SILENCE_THRESHOLD) {
          if (heardSpeechAt === null) heardSpeechAt = now;
          lastVoiceAt = now;
        }
        if (
          heardSpeechAt !== null &&
          lastVoiceAt - heardSpeechAt >= MIN_SPEECH_DURATION_MS &&
          now - lastVoiceAt >= SILENCE_DURATION_MS
        ) {
          recorder.stop();
          return;
        }
        animationFrameRef.current = requestAnimationFrame(detectSilence);
      };
      animationFrameRef.current = requestAnimationFrame(detectSilence);
    } catch {
      failConversation("Microphone access is required for voice conversation.");
    }
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the recorder and audio callbacks using the latest committed start-listening handler.
  useLayoutEffect(() => {
    startListeningRef.current = startListening;
  });

  const toggleConversation = () => {
    if (activeRef.current) {
      stopConversation();
      return;
    }
    activeRef.current = true;
    setActive(true);
    setHeard(null);
    setSpoken(null);
    unlockPlayback();
    void startListeningRef.current();
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Start audio playback when the pending assistant reply finishes streaming.
  useEffect(() => {
    const pendingIds = pendingAssistantIdsRef.current;
    if (!pendingIds || !activeRef.current) return;
    const reply = [...messages]
      .toReversed()
      .find(
        (message) =>
          message.role === "assistant" &&
          !pendingIds.has(message.id) &&
          !message.streaming &&
          message.text.trim(),
      );
    if (!reply) return;
    pendingAssistantIdsRef.current = null;
    void speak(reply);
  }, [messages, speak]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Retain original-reply invalidation for imperative voice commands; deriving this flag alone would leave the playback ref stale.
  useEffect(() => {
    const originalReply = originalReplyRef.current;
    if (
      originalReply &&
      !messages.some(
        (message) => message.role === "assistant" && message.text === originalReply.text,
      )
    ) {
      originalReplyRef.current = null;
      setHasOriginalReply(false);
    }
  }, [messages]);

  const stopConversationRef = useRef(stopConversation);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep unmount cleanup using the latest committed recorder and audio stop handler.
  useLayoutEffect(() => {
    stopConversationRef.current = stopConversation;
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Release microphone tracks, audio playback, and recording resources when the hook unmounts.
  useEffect(() => () => stopConversationRef.current(), []);

  return {
    active,
    status,
    hasOriginalReply,
    levelRef,
    heard,
    spoken,
    toggleConversation,
    stopConversation,
  };
}
