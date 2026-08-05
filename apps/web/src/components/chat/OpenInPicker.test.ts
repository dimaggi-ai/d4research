import { describe, expect, it } from "vite-plus/test";

import { resolveOpenInOptions } from "./OpenInPicker";

describe("resolveOpenInOptions", () => {
  it("always exposes the in-app file browser on remote clients", () => {
    expect(resolveOpenInOptions("Linux", []).map((option) => option.value)).toEqual([
      "file-manager",
    ]);
  });

  it("does not expose the Agy provider CLI as a project opener", () => {
    expect(
      resolveOpenInOptions("Linux", ["antigravity" as never]).map((option) => option.value),
    ).toEqual(["file-manager"]);
  });

  it("uses the platform file-browser label", () => {
    expect(resolveOpenInOptions("MacIntel", []).at(-1)?.label).toBe("Finder");
    expect(resolveOpenInOptions("Win32", []).at(-1)?.label).toBe("Explorer");
    expect(resolveOpenInOptions("Linux", []).at(-1)?.label).toBe("Files");
  });
});
