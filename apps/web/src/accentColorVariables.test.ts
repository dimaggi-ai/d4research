import { describe, expect, it } from "vite-plus/test";

import { resolveAccentColorVariables } from "./themePalette";

function lightnessOf(oklch: string): number {
  const match = oklch.match(/^oklch\(([\d.]+)/);
  return match ? Number(match[1]) : Number.NaN;
}

function hueOf(oklch: string): number {
  const parts = oklch.replace(/^oklch\(|\)$/g, "").split(/\s+/);
  return Number(parts[2]);
}

describe("resolveAccentColorVariables", () => {
  it("rejects anything that is not a colour", () => {
    expect(resolveAccentColorVariables("not-a-colour", "dark")).toBeNull();
    expect(resolveAccentColorVariables("", "light")).toBeNull();
  });

  it("keeps the chosen hue", () => {
    const green = resolveAccentColorVariables("#16a34a", "dark");
    const red = resolveAccentColorVariables("#dc2626", "dark");
    expect(Math.round(hueOf(green!.primary))).toBeGreaterThan(120);
    expect(Math.round(hueOf(red!.primary))).toBeLessThan(60);
  });

  it("pulls a too-dark colour up into the accent band", () => {
    const nearBlack = resolveAccentColorVariables("#050d2a", "dark");
    expect(lightnessOf(nearBlack!.primary)).toBeGreaterThanOrEqual(0.48);
  });

  it("pulls a too-light colour down into the accent band", () => {
    const nearWhite = resolveAccentColorVariables("#eef4ff", "light");
    expect(lightnessOf(nearWhite!.primary)).toBeLessThanOrEqual(0.6);
  });

  it("lifts the dark accent above the light one for the same colour", () => {
    const light = resolveAccentColorVariables("#0b1f6b", "light");
    const dark = resolveAccentColorVariables("#0b1f6b", "dark");
    expect(lightnessOf(dark!.primary)).toBeGreaterThan(lightnessOf(light!.primary));
  });

  it("places a grey at the standard lightness rather than leaving it in the surface", () => {
    const grey = resolveAccentColorVariables("#808080", "light");
    expect(lightnessOf(grey!.primary)).toBeCloseTo(0.488, 3);
  });

  it("picks a foreground that can be read on the accent", () => {
    for (const hex of ["#16a34a", "#dc2626", "#eef4ff", "#050d2a"]) {
      for (const appearance of ["light", "dark"] as const) {
        const resolved = resolveAccentColorVariables(hex, appearance);
        expect(resolved?.primaryForeground).toMatch(/^oklch\(/);
      }
    }
  });
});
