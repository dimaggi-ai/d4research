import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const repoRoot = NodeURL.fileURLToPath(new URL("../", import.meta.url));

it("keeps product source and manifests free of tracking SDKs and external trace exporters", async () => {
  const violations: string[] = [];
  for (const root of ["apps", "packages"]) {
    for (const file of await NodeFSP.readdir(NodePath.join(repoRoot, root), { recursive: true })) {
      if (/(^|\/)(node_modules|dist|dist-electron|build|\.expo|\.vite)(\/|$)/.test(file)) continue;
      if (!/\.(tsx?|jsx?|mjs|cjs|astro|html|json)$/.test(file)) continue;
      if (/\.(test|spec)\./.test(file) || file.includes("/e2e/")) continue;
      const path = NodePath.join(repoRoot, root, file);
      if (!(await NodeFSP.stat(path)).isFile()) continue;
      const source = await NodeFSP.readFile(path, "utf8");
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
