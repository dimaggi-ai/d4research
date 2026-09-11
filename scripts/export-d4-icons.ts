import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import { BRAND_ASSET_PATHS, resolveWebIconOverrides } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const root = new URL("../", import.meta.url);
const sourcePath = "assets/d4/mark.svg";
const manifestPath = "assets/d4/generated.json";
const digest = (bytes: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export async function checkD4Icons() {
  const manifest = JSON.parse(await NodeFSP.readFile(new URL(manifestPath, root), "utf8")) as {
    source: string;
    outputs: Record<string, string>;
  };
  if (manifest.source !== digest(await NodeFSP.readFile(new URL(sourcePath, root)))) {
    throw new Error("d4 icon source changed. Run vp run icons:export.");
  }
  for (const [path, expected] of Object.entries(manifest.outputs)) {
    if (digest(await NodeFSP.readFile(new URL(path, root))) !== expected) {
      throw new Error(`Stale d4 icon: ${path}. Run vp run icons:export.`);
    }
  }
  // Include every release channel: publish-time overrides must not restore old icons.
  for (const path of Object.values(BRAND_ASSET_PATHS)) {
    const output = path.endsWith(".icon") ? `${path}/Assets/text.svg` : path;
    if (!(output in manifest.outputs)) throw new Error(`Uncovered icon asset: ${output}`);
  }
}

async function exportD4Icons() {
  const source = await NodeFSP.readFile(new URL(sourcePath, root), "utf8");
  const outputs: Record<string, string> = {};
  async function save(path: string, bytes: string | Buffer) {
    await NodeFSP.writeFile(new URL(path, root), bytes);
    outputs[path] = digest(bytes);
  }
  const renditions = new Map<string, Buffer>();
  function render(svg: string, size: number) {
    const key = `${size}:${svg}`;
    let bytes = renditions.get(key);
    if (!bytes) {
      bytes = NodeChildProcess.execFileSync(
        "rsvg-convert",
        ["-w", String(size), "-h", String(size)],
        {
          input: svg,
          timeout: 10000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
      renditions.set(key, bytes);
    }
    return bytes;
  }
  const foreground = source.replace(/\s*<rect[^>]+\/>/, "");
  for (const path of Object.values(BRAND_ASSET_PATHS)) {
    if (path.endsWith(".icon")) {
      // Icon Composer scales its 128-point foreground independently of the background.
      await save(
        `${path}/Assets/text.svg`,
        foreground.replace('width="64" height="64"', 'width="128" height="128"'),
      );
    } else if (path.endsWith(".ico")) {
      const sizes = path.includes("windows") ? WINDOWS_ICON_SIZES : [16, 32, 48];
      await save(
        path,
        encodePngIco(sizes.map((size) => ({ size, contents: render(source, size) }))),
      );
    } else {
      const size = path.includes("16x16")
        ? 16
        : path.includes("32x32")
          ? 32
          : path.includes("180")
            ? 180
            : 1024;
      await save(path, render(source, size));
    }
  }
  await save("assets/prod/logo.svg", source);
  await save(
    "apps/mobile/assets/widget/T3Mark.svg",
    foreground.replace(
      'width="64" height="64" viewBox="0 0 64 64"',
      'width="96" height="64" viewBox="9 14 48 32"',
    ),
  );
  await save("apps/web/public/d4-mark.svg", source);
  for (const entry of resolveWebIconOverrides("production", "apps/web/public")) {
    await save(
      entry.targetRelativePath,
      await NodeFSP.readFile(new URL(entry.sourceRelativePath, root)),
    );
  }
  // Adaptive icons need a transparent foreground inside the Android safe zone.
  const androidForeground = foreground
    .replace("<g fill=", '<g transform="translate(8 8) scale(0.75)"><g fill=')
    .replace("</g>", "</g></g>");
  await save("apps/mobile/assets/android-icon-foreground.svg", androidForeground);
  for (const name of [
    "android-icon-foreground",
    "android-icon-mark",
    "android-notification-icon",
  ]) {
    await save(
      `apps/mobile/assets/${name}.png`,
      render(androidForeground, name.includes("notification") ? 96 : 432),
    );
  }
  await NodeFSP.writeFile(
    new URL(manifestPath, root),
    `${JSON.stringify({ source: digest(source), outputs }, null, 2)}\n`,
  );
  console.log(`Generated ${Object.keys(outputs).length} d4 icon assets from ${sourcePath}`);
}

if (process.argv[1] === NodeURL.fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) await checkD4Icons();
  else await exportD4Icons();
}
