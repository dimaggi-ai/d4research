import { describe, expect, it } from "vite-plus/test";

import {
  resolveWorkspaceColor,
  workspaceDirectoryName,
  workspaceDisplayName,
} from "./projectWorkspacePresentation";

describe("project workspace presentation", () => {
  it("uses directory names instead of the legacy primary label", () => {
    expect(workspaceDirectoryName("/Users/example/projects/meko/")).toBe("meko");
    expect(
      workspaceDisplayName({ path: "/Users/example/projects/meko", label: "Primary directory" }, 0),
    ).toBe("meko");
    expect(workspaceDisplayName({ path: "/tmp/qa-services", label: "QA" }, 1)).toBe("QA");
  });

  it("assigns stable defaults and honors a saved color", () => {
    expect(resolveWorkspaceColor({ color: undefined }, 0)).toBe("red");
    expect(resolveWorkspaceColor({ color: undefined }, 1)).toBe("orange");
    expect(resolveWorkspaceColor({ color: "violet" }, 1)).toBe("violet");
  });
});
