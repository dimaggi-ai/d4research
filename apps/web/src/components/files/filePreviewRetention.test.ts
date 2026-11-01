import { describe, expect, it } from "vite-plus/test";
import { retainFilePreview } from "./filePreviewRetention";

describe("open file preview retention", () => {
  it.each(["README.md", "src/app.tsx", "config.json", "data.csv"])("retains %s", (path) => {
    expect(retainFilePreview(path, false)).toBe(true);
  });
  it.each(["clip.mp4", "sound.mp3", "image.png", "page.html", "report.pdf"])(
    "stops hidden %s",
    (path) => {
      expect(retainFilePreview(path, false)).toBe(false);
    },
  );
  it("does not retain attachment viewers", () => {
    expect(retainFilePreview("note.md", true)).toBe(false);
  });
});
