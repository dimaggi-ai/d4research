// @effect-diagnostics nodeBuiltinImport:off - This repository privacy test scans source files directly.
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const repoRoot = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "dist-electron",
  "build",
  ".expo",
  ".vite",
]);

// A recursive readdir would list every installed dependency before filtering.
async function* sourceFiles(directory: string, relative = ""): AsyncGenerator<string> {
  for (const entry of await NodeFSP.readdir(NodePath.join(directory, relative), {
    withFileTypes: true,
  })) {
    const file = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) yield* sourceFiles(directory, file);
    } else if (entry.isFile()) {
      yield file;
    }
  }
}

it("keeps product source and manifests free of tracking SDKs and external trace exporters", async () => {
  const violations: string[] = [];
  for (const root of ["apps", "packages"]) {
    for await (const file of sourceFiles(NodePath.join(repoRoot, root))) {
      if (!/\.(tsx?|jsx?|mjs|cjs|astro|html|json)$/.test(file)) continue;
      if (/\.(test|spec)\./.test(file) || file.includes("/e2e/")) continue;
      const source = await NodeFSP.readFile(NodePath.join(repoRoot, root, file), "utf8");
      const tracking =
        /(?:@sentry\/|posthog-js|posthog-node|@segment\/analytics|mixpanel-browser|@amplitude\/analytics|@vercel\/analytics|googletagmanager\.com|google-analytics\.com|api\.axiom\.co|navigator\.sendBeacon\s*\()/i;
      // The browser sends diagnostic spans only to its paired environment, never a vendor.
      const externalExporter = /Otlp(?:Tracer|Metrics|Logger)\.(?:make|layer)\s*\(/;
      if (
        tracking.test(source) ||
        (externalExporter.test(source) && file !== "web/src/observability/clientTracing.ts")
      )
        violations.push(`${root}/${file}`);
    }
  }
  expect(violations).toEqual([]);
});
