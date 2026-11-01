import { describe, expect, it } from "vite-plus/test";

import {
  ACCENT_COLOR_OPTIONS,
  accentColorLabel,
  isAccentColorValue,
  projectAccentStyle,
  resolveAccentHex,
  threadCardAccentStyle,
} from "./accentColors";

describe("resolveAccentHex", () => {
  it("resolves a palette id to its colour", () => {
    expect(resolveAccentHex("teal")).toBe("#4e938c");
  });

  it("passes a literal hex through", () => {
    expect(resolveAccentHex("#A1B2C3")).toBe("#A1B2C3");
    expect(resolveAccentHex("#abc")).toBe("#abc");
  });

  it("rejects anything else", () => {
    expect(resolveAccentHex(null)).toBeNull();
    expect(resolveAccentHex("")).toBeNull();
    expect(resolveAccentHex("chartreuse")).toBeNull();
    expect(resolveAccentHex("#12345")).toBeNull();
    expect(resolveAccentHex("javascript:alert(1)")).toBeNull();
  });
});

describe("isAccentColorValue", () => {
  it("accepts palette ids and hex, and nothing else", () => {
    expect(isAccentColorValue("violet")).toBe(true);
    expect(isAccentColorValue("#102030")).toBe(true);
    expect(isAccentColorValue("url(evil)")).toBe(false);
  });
});

describe("accentColorLabel", () => {
  it("names a palette colour and upper-cases a custom one", () => {
    expect(accentColorLabel("green")).toBe("Green");
    expect(accentColorLabel("#a1b2c3")).toBe("#A1B2C3");
    expect(accentColorLabel(null)).toBeNull();
  });
});

describe("threadCardAccentStyle", () => {
  it("is absent when neither colour is set", () => {
    expect(threadCardAccentStyle({ threadColor: null, projectColor: null })).toBeUndefined();
    expect(
      threadCardAccentStyle({ threadColor: "not-a-colour", projectColor: undefined }),
    ).toBeUndefined();
  });

  it("draws the thread colour from the left and rules the leading edge", () => {
    const style = threadCardAccentStyle({ threadColor: "red", projectColor: null });
    expect(style?.backgroundImage).toContain("linear-gradient(to right,");
    expect(style?.backgroundImage).not.toContain("to left");
    expect(style?.boxShadow).toContain("inset 2px 0 0 0");
  });

  it("draws the project colour from the right without a leading rule", () => {
    const style = threadCardAccentStyle({ threadColor: null, projectColor: "blue" });
    expect(style?.backgroundImage).toContain("linear-gradient(to left,");
    expect(style?.boxShadow).toBeUndefined();
  });

  it("layers both colours, thread first", () => {
    const style = threadCardAccentStyle({ threadColor: "red", projectColor: "blue" });
    const image = style?.backgroundImage ?? "";
    expect(image.indexOf("to right")).toBeLessThan(image.indexOf("to left"));
    expect(image).toContain("#b25a52");
    expect(image).toContain("#5b7fb8");
  });

  it("fades out within the leading third of the card", () => {
    const style = threadCardAccentStyle({ threadColor: "green", projectColor: null });
    expect(style?.backgroundImage).toContain("transparent 29%");
  });
});

describe("projectAccentStyle", () => {
  it("is absent without a colour and washes the row with one", () => {
    expect(projectAccentStyle(null)).toBeUndefined();
    expect(projectAccentStyle("amber")?.backgroundImage).toContain("#a8913f");
  });
});

describe("ACCENT_COLOR_OPTIONS", () => {
  it("offers ten distinct colours with unique ids", () => {
    expect(ACCENT_COLOR_OPTIONS).toHaveLength(10);
    expect(new Set(ACCENT_COLOR_OPTIONS.map((option) => option.id)).size).toBe(10);
    expect(new Set(ACCENT_COLOR_OPTIONS.map((option) => option.hex)).size).toBe(10);
  });
});
