import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../types";

const DEFAULT_VOICE_GATEWAY_URL = "http://127.0.0.1:8093";
const SILENCE_THRESHOLD = 0.025;
const SILENCE_DURATION_MS = 900;
const MIN_SPEECH_DURATION_MS = 250;
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
  waiting: { label: "Thinking", detail: "Waiting for T3Code to reply" },
  summarizing: { label: "Summarizing", detail: "Gemma is making the reply easier to listen to" },
  speaking: { label: "Speaking", detail: "Playing T3Code's reply locally" },
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

export function spokenExcerpt(markdown: string): string {
  const text = speechReadyText(markdown);
  return text
    .split(/(?<=[.!?])\s+/)
    .slice(0, 2)
    .join(" ")
    .slice(0, 360);
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
  } = {},
): Promise<string> {
  const fallback = spokenExcerpt(markdown);
  if (!fallback) return "";

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

export function useVoiceConversation(options: {
  messages: readonly ChatMessage[];
  onTranscript: (transcript: string) => boolean;
  onError: (message: string) => void;
}) {
  const { messages, onError, onTranscript } = options;
  const [status, setStatus] = useState<VoiceConversationStatus>("idle");
  const [active, setActive] = useState(false);
  const [hasOriginalReply, setHasOriginalReply] = useState(false);
  const activeRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const cancelRecordingRef = useRef(false);
  const chunksRef = useRef<Blob[]>([]);
  const pendingAssistantIdsRef = useRef<Set<string> | null>(null);
  const originalReplyRef = useRef<string | null>(null);
  const startListeningRef = useRef<() => Promise<void>>(async () => undefined);

  const stopTracks = useCallback(() => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const stopPlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    if (audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
    audio.removeAttribute("src");
    audio.onended = null;
    audio.onerror = null;
    audioRef.current = null;
  }, []);

  // iOS only allows delayed playback when an audio element was unlocked by
  // the original tap. Reuse that element for every spoken reply in this
  // conversation instead of creating one after the model finishes.
  const unlockPlayback = useCallback(() => {
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
  }, []);

  const stopConversation = useCallback(() => {
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
    setStatus("idle");
  }, [stopPlayback, stopTracks]);

  const failConversation = useCallback(
    (message: string) => {
      stopConversation();
      onError(message);
    },
    [onError, stopConversation],
  );

  const speak = useCallback(
    async (markdown: string, summarize = true) => {
      if (!spokenExcerpt(markdown)) {
        if (activeRef.current) void startListeningRef.current();
        return;
      }
      const unlockedAudio = audioRef.current;
      unlockedAudio?.pause();
      if (summarize) {
        originalReplyRef.current = markdown;
        setHasOriginalReply(true);
        setStatus("summarizing");
      }
      try {
        const text = summarize
          ? await summarizeReplyForSpeech(markdown)
          : speechReadyText(markdown).slice(0, 6_000);
        if (!activeRef.current) return;
        setStatus("speaking");
        const body = new URLSearchParams({ text });
        const response = await fetch(`${voiceGatewayUrl()}/voice/tts`, { method: "POST", body });
        if (!response.ok) throw new Error(`Voice gateway returned ${response.status}`);
        const audio = unlockedAudio ?? new Audio();
        const objectUrl = URL.createObjectURL(await response.blob());
        audio.src = objectUrl;
        audio.setAttribute("playsinline", "");
        audioRef.current = audio;
        const finish = () => {
          URL.revokeObjectURL(objectUrl);
          audio.removeAttribute("src");
          audio.onended = null;
          audio.onerror = null;
          if (activeRef.current) window.setTimeout(() => void startListeningRef.current(), 300);
        };
        audio.onended = finish;
        audio.onerror = () => failConversation("The local voice gateway could not play the reply.");
        await audio.play();
      } catch {
        failConversation(voiceGatewayUnavailableMessage());
      }
    },
    [failConversation],
  );

  const expectAssistantReply = useCallback(() => {
    pendingAssistantIdsRef.current = new Set(
      messages.filter((message) => message.role === "assistant").map((message) => message.id),
    );
  }, [messages]);

  const transcribeRecording = useCallback(
    async (audio: Blob, mimeType: string) => {
      if (!activeRef.current) return;
      setStatus("transcribing");
      try {
        const form = new FormData();
        form.append("audio", audio, `voice.${recordingExtension(mimeType)}`);
        const response = await fetch(`${voiceGatewayUrl()}/voice/transcribe`, {
          method: "POST",
          body: form,
        });
        if (!response.ok) throw new Error(`Voice gateway returned ${response.status}`);
        const result = (await response.json()) as { text?: unknown };
        const transcript = typeof result.text === "string" ? result.text.trim() : "";
        if (!transcript) {
          await startListeningRef.current();
          return;
        }
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
    },
    [expectAssistantReply, failConversation, onTranscript, speak, stopConversation],
  );

  const startListening = useCallback(async () => {
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
        if (rms >= SILENCE_THRESHOLD) {
          heardSpeechAt ??= now;
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
  }, [failConversation, stopTracks, transcribeRecording]);
  startListeningRef.current = startListening;

  const toggleConversation = useCallback(() => {
    if (activeRef.current) {
      stopConversation();
      return;
    }
    activeRef.current = true;
    setActive(true);
    unlockPlayback();
    void startListeningRef.current();
  }, [stopConversation, unlockPlayback]);

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
    void speak(reply.text);
  }, [messages, speak]);

  useEffect(() => {
    const originalReply = originalReplyRef.current;
    if (
      originalReply &&
      !messages.some((message) => message.role === "assistant" && message.text === originalReply)
    ) {
      originalReplyRef.current = null;
      setHasOriginalReply(false);
    }
  }, [messages]);

  useEffect(() => stopConversation, [stopConversation]);

  return { active, status, hasOriginalReply, toggleConversation, stopConversation };
}
