import { createRoot, type Root } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";

import { PodcastPlayerView } from "../src/components/chat/PodcastPlayer";

let root: Root | null = null;

function createSilentWavUrl(seconds: number): string {
  const sampleRate = 8_000;
  const sampleCount = Math.floor(sampleRate * seconds);
  const buffer = new ArrayBuffer(44 + sampleCount * 2);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + sampleCount * 2, true);
  writeText(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, sampleCount * 2, true);
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

function Fixture() {
  const [artifacts, setArtifacts] = useState(["episodes/one.wav", "episodes/two.wav"]);
  const urls = useMemo(() => [createSilentWavUrl(2), createSilentWavUrl(3)], []);

  useEffect(() => () => urls.forEach((url) => URL.revokeObjectURL(url)), [urls]);

  return (
    <PodcastPlayerView
      artifacts={artifacts}
      urls={artifacts.map((path) => urls[path.endsWith("one.wav") ? 0 : 1] ?? null)}
      onRemove={(path) => setArtifacts((current) => current.filter((item) => item !== path))}
    />
  );
}

export function mountPodcastPlayerFixture(container: HTMLElement) {
  root?.unmount();
  root = createRoot(container);
  root.render(<Fixture />);
}

export function unmountPodcastPlayerFixture() {
  root?.unmount();
  root = null;
}
