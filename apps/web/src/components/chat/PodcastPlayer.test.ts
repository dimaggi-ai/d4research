import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../assets/assetUrls", () => ({
  useAssetUrls: (_environmentId: string, resources: ReadonlyArray<{ path: string }>) =>
    resources.map(({ path }) => `https://assets.invalid/${encodeURIComponent(path)}`),
}));

import {
  clampPodcastTime,
  formatPodcastTime,
  nextPodcastPlaybackRate,
  normalizePodcastDuration,
  PodcastPlayer,
} from "./PodcastPlayer";

describe("formatPodcastTime", () => {
  it.each([
    [0, "0:00"],
    [9.9, "0:09"],
    [60, "1:00"],
    [3_661.8, "61:01"],
    [Number.NaN, "0:00"],
    [Number.POSITIVE_INFINITY, "0:00"],
    [-1, "0:00"],
  ])("formats %s without leaking invalid media metadata", (seconds, expected) => {
    expect(formatPodcastTime(seconds)).toBe(expected);
  });
});

describe("nextPodcastPlaybackRate", () => {
  it("cycles through every advertised rate and wraps", () => {
    expect(nextPodcastPlaybackRate(1)).toBe(1.25);
    expect(nextPodcastPlaybackRate(1.25)).toBe(1.5);
    expect(nextPodcastPlaybackRate(1.5)).toBe(1.75);
    expect(nextPodcastPlaybackRate(1.75)).toBe(2);
    expect(nextPodcastPlaybackRate(2)).toBe(1);
  });
});

describe("podcast media bounds", () => {
  it.each([
    [120, 120],
    [0, 0],
    [-1, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ])("normalizes duration %s to %s", (duration, expected) => {
    expect(normalizePodcastDuration(duration)).toBe(expected);
  });

  it.each([
    [15, 60, 15],
    [-15, 60, 0],
    [75, 60, 60],
    [Number.NaN, 60, 0],
    [30, Number.POSITIVE_INFINITY, 0],
  ])("clamps time %s against duration %s to %s", (time, duration, expected) => {
    expect(clampPodcastTime(time, duration)).toBe(expected);
  });
});

describe("PodcastPlayer rendering", () => {
  const render = (artifacts: ReadonlyArray<string>) =>
    renderToStaticMarkup(
      createElement(PodcastPlayer, {
        environmentId: "local" as never,
        threadId: "thread-e2e" as never,
        artifacts,
        onRemove: vi.fn(),
      }),
    );

  it("does not mount controls without an audio artifact", () => {
    expect(render([])).toBe("");
  });

  it("renders the real transport and a workspace asset for one artifact", () => {
    const html = render(["generated/deep dive.mp3"]);

    expect(html).toContain("deep dive.mp3");
    expect(html).toContain("https://assets.invalid/generated%2Fdeep%20dive.mp3");
    expect(html).toContain('preload="metadata"');
    expect(html).toContain('aria-label="Back 15 seconds"');
    expect(html).toContain('aria-label="Play"');
    expect(html).toContain('aria-label="Forward 15 seconds"');
    expect(html).toContain('aria-label="Seek"');
    expect(html).toContain('aria-label="Playback speed"');
    expect(html).toContain('aria-label="Remove audio artifact"');
    expect(html).not.toContain('aria-label="Next audio"');
  });

  it("renders bounded navigation for multiple artifacts", () => {
    const html = render(["one.wav", "nested/two.ogg"]);

    expect(html).toContain("1/2");
    expect(html).toContain('aria-label="Previous audio"');
    expect(html).toContain('aria-label="Next audio"');
    expect(html).toContain('disabled="" aria-label="Previous audio"');
    expect(html).not.toContain('disabled="" aria-label="Next audio"');
  });
});
