import { useEffect, useRef, type RefObject } from "react";
import type { VoiceConversationStatus } from "../../hooks/useVoiceConversation";
import { observeResize } from "../../lib/observeResize";

// Voice mode is a deliberate full-screen state, so the core animates while it is open. It is
// capped at 30 fps, stops with the tab hidden, and draws one still frame under reduced motion.
const FRAME_INTERVAL_MS = 1000 / 30;
const BARS = 64;
const TICKS = 96;

const HUE: Record<VoiceConversationStatus, number> = {
  idle: 192,
  listening: 178,
  transcribing: 205,
  waiting: 258,
  summarizing: 280,
  speaking: 196,
};

function isThinking(status: VoiceConversationStatus) {
  return status === "transcribing" || status === "waiting" || status === "summarizing";
}

function drawCore(
  context: CanvasRenderingContext2D,
  size: number,
  time: number,
  level: number,
  status: VoiceConversationStatus,
  dark: boolean,
) {
  const center = size / 2;
  const hue = HUE[status];
  const thinking = isThinking(status);
  const spin = thinking ? 2.6 : 1;
  const color = (lightness: number, alpha: number) =>
    `hsla(${hue}, 95%, ${dark ? lightness : Math.max(30, lightness - 22)}%, ${alpha})`;

  context.clearRect(0, 0, size, size);
  context.globalCompositeOperation = dark ? "lighter" : "source-over";

  const halo = context.createRadialGradient(center, center, size * 0.08, center, center, size / 2);
  halo.addColorStop(0, color(60, 0.28 + level * 0.32));
  halo.addColorStop(0.55, color(50, 0.08 + level * 0.1));
  halo.addColorStop(1, color(40, 0));
  context.fillStyle = halo;
  context.fillRect(0, 0, size, size);

  context.lineCap = "round";
  context.lineWidth = Math.max(1, size * 0.004);
  for (let index = 0; index < TICKS; index += 1) {
    const angle = (index / TICKS) * Math.PI * 2 + time * 0.08;
    const long = index % 8 === 0;
    const inner = size * (long ? 0.445 : 0.455);
    const outer = size * 0.47;
    context.strokeStyle = color(70, long ? 0.75 : 0.3);
    context.beginPath();
    context.moveTo(center + Math.cos(angle) * inner, center + Math.sin(angle) * inner);
    context.lineTo(center + Math.cos(angle) * outer, center + Math.sin(angle) * outer);
    context.stroke();
  }

  const arcs = [
    { radius: 0.4, width: 0.012, span: 1.6, speed: 0.35, alpha: 0.85 },
    { radius: 0.4, width: 0.012, span: 0.5, speed: 0.35, offset: Math.PI, alpha: 0.6 },
    { radius: 0.36, width: 0.006, span: 2.4, speed: -0.55, alpha: 0.55 },
    { radius: 0.255, width: 0.018, span: 0.9, speed: 0.9, alpha: 0.7 },
    { radius: 0.255, width: 0.018, span: 0.9, speed: 0.9, offset: Math.PI, alpha: 0.7 },
  ];
  for (const arc of arcs) {
    const start = time * arc.speed * spin + (arc.offset ?? 0);
    context.strokeStyle = color(68, arc.alpha);
    context.lineWidth = size * arc.width;
    context.beginPath();
    context.arc(center, center, size * arc.radius, start, start + arc.span);
    context.stroke();
  }

  context.lineWidth = Math.max(1.5, size * 0.007);
  for (let index = 0; index < BARS; index += 1) {
    const angle = (index / BARS) * Math.PI * 2 - Math.PI / 2;
    const wave = thinking
      ? 0.18 + 0.82 * Math.max(0, Math.cos(angle - time * 3.2)) ** 6
      : 0.12 +
        level *
          (0.55 + 0.45 * Math.sin(index * 1.7 + time * 7) * Math.sin(index * 0.6 - time * 3.1));
    const inner = size * 0.29;
    const outer = inner + size * 0.085 * Math.max(0.08, wave);
    context.strokeStyle = color(72, 0.35 + 0.6 * Math.min(1, wave));
    context.beginPath();
    context.moveTo(center + Math.cos(angle) * inner, center + Math.sin(angle) * inner);
    context.lineTo(center + Math.cos(angle) * outer, center + Math.sin(angle) * outer);
    context.stroke();
  }

  const breathe = thinking ? 0.06 * Math.sin(time * 4) : 0.03 * Math.sin(time * 1.6);
  const radius = size * (0.15 + 0.07 * level + breathe * 0.5);
  const orb = context.createRadialGradient(center, center, 0, center, center, radius);
  orb.addColorStop(0, `hsla(${hue}, 100%, ${dark ? 96 : 88}%, 0.95)`);
  orb.addColorStop(0.35, color(66, 0.85));
  orb.addColorStop(0.75, color(50, 0.35));
  orb.addColorStop(1, color(45, 0));
  context.fillStyle = orb;
  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.fill();

  context.globalCompositeOperation = "source-over";
  context.strokeStyle = color(78, 0.5);
  context.lineWidth = Math.max(1, size * 0.003);
  context.beginPath();
  context.arc(center, center, size * 0.205, 0, Math.PI * 2);
  context.stroke();
}

export function NiaVoiceCore({
  status,
  levelRef,
  className,
}: {
  status: VoiceConversationStatus;
  levelRef: RefObject<number>;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives the canvas animation frame loop and its size while mounted; restarting per status repaints the reduced-motion still frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame: number | null = null;
    let last = 0;
    let level = 0;
    let size = 0;
    const resize = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      size = canvas.clientWidth;
      canvas.width = Math.round(size * ratio);
      canvas.height = Math.round(size * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const paint = (now: number) => {
      const target = levelRef.current ?? 0;
      level += (target - level) * (target > level ? 0.45 : 0.12);
      drawCore(
        context,
        size,
        now / 1000,
        level,
        status,
        document.documentElement.classList.contains("dark"),
      );
    };
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < FRAME_INTERVAL_MS) return;
      last = now;
      paint(now);
    };
    const restart = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (reducedMotion.matches) paint(0);
      else frame = requestAnimationFrame(tick);
    };
    resize();
    const stopObserving = observeResize(canvas, () => {
      resize();
      if (reducedMotion.matches) paint(0);
    });
    restart();
    reducedMotion.addEventListener("change", restart);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      stopObserving();
      reducedMotion.removeEventListener("change", restart);
    };
  }, [levelRef, status]);

  return (
    <canvas ref={canvasRef} aria-hidden="true" data-nia-voice-core={status} className={className} />
  );
}
