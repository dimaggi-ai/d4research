import { expect, it } from "vite-plus/test";
import { readFile, readdir } from "node:fs/promises";
import { checkD4Icons } from "./export-d4-icons.ts";

it("keeps every d4 icon and publish-time override in sync with the canonical mark", async () => {
  await checkD4Icons();
});

it("keeps visible desktop and web copy free of upstream product branding", async () => {
  for (const root of ["apps/web/src", "apps/desktop/src", "apps/desktop/gnome-extension"]) {
    for (const file of await readdir(root, { recursive: true })) {
      if (!/\.(tsx?|jsx?|json)$/.test(file) || file.includes(".test.")) continue;
      const source = await readFile(`${root}/${file}`, "utf8");
      const visibleLines = source
        .split("\n")
        .filter(
          (line) =>
            !/^\s*(\/\/|\*|\/\*)/.test(line) && !line.includes("const legacyUserDataDirName ="),
        );
      expect(visibleLines.join("\n"), `${root}/${file}`).not.toMatch(/T3\s+Code/);
    }
  }
});

it("uses the canonical d4 mark in inherited wordmarks and Mac installers", async () => {
  const wordmark = await readFile("apps/web/src/components/T3Wordmark.tsx", "utf8");
  expect(wordmark).toContain('href="/d4-mark.svg"');
  expect(wordmark).not.toContain("M33.4509");
  for (const channel of ["latest", "nightly"]) {
    const installer = await readFile(
      `apps/desktop/resources/dmg/dmg-background-${channel}.svg`,
      "utf8",
    );
    expect(installer).toContain("Drag d4research into Applications.");
    expect(installer).toContain("M535 143");
    expect(installer).not.toContain("M33.4509");
  }
});
