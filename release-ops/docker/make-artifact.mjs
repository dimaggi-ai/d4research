// Produce an installable distribution tarball from apps/server/dist.
//
// The workspace package.json declares external dependencies with "catalog:"
// specifiers that only the workspace package manager understands; a raw
// `npm pack` of it is not installable anywhere else (the P0 smoke caught
// exactly this). This step resolves catalog specifiers against
// pnpm-workspace.yaml, drops the dependencies the bundler already inlined,
// and packs a staging manifest without mutating the repo.
//
//   node release-ops/docker/make-artifact.mjs <out-tarball-path>
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const serverDir = path.join(repo, "apps/server");
const outPath = process.argv[2] ?? path.join(here, "t3-artifact.tgz");

const manifest = JSON.parse(fs.readFileSync(path.join(serverDir, "package.json"), "utf8"));

// Mirrors shouldBundleCliDependency in apps/server/vite.config.ts: these are
// inlined into dist/bin.mjs and must not appear as install-time dependencies.
const bundledPrefixes = ["@pierre/diffs", "@t3tools/", "effect-acp", "effect-codex-app-server"];
const isBundled = (name) => bundledPrefixes.some((prefix) => name.startsWith(prefix));

// The catalog is a flat "name: version" block in pnpm-workspace.yaml.
const workspaceYaml = fs.readFileSync(path.join(repo, "pnpm-workspace.yaml"), "utf8");
const catalog = {};
let inCatalog = false;
for (const line of workspaceYaml.split("\n")) {
  if (/^catalog:\s*$/.test(line)) {
    inCatalog = true;
    continue;
  }
  if (inCatalog) {
    const entry = line.match(/^\s{2}"?([^":]+)"?:\s*(\S.*)$/);
    if (entry) {
      catalog[entry[1]] = entry[2].trim();
      continue;
    }
    if (!/^\s/.test(line) && line.trim() !== "") inCatalog = false;
  }
}

const dependencies = {};
const unresolved = [];
for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
  if (isBundled(name)) continue;
  if (spec === "catalog:") {
    if (catalog[name]) dependencies[name] = catalog[name];
    else unresolved.push(name);
  } else if (spec.startsWith("workspace:")) {
    unresolved.push(name);
  } else {
    dependencies[name] = spec;
  }
}
if (unresolved.length > 0) {
  console.error(`unresolvable dependency specifiers for distribution: ${unresolved.join(", ")}`);
  process.exit(1);
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "t3-dist-"));
fs.cpSync(path.join(serverDir, "dist"), path.join(stage, "dist"), { recursive: true });
fs.writeFileSync(
  path.join(stage, "package.json"),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      type: manifest.type,
      bin: manifest.bin,
      files: ["dist"],
      dependencies,
    },
    null,
    2,
  ),
);

const tarball = execFileSync("npm", ["pack", "--silent"], { cwd: stage, encoding: "utf8" }).trim();
fs.copyFileSync(path.join(stage, tarball), outPath);
fs.rmSync(stage, { recursive: true, force: true });
console.log(
  `${path.basename(outPath)} <- ${tarball} (${Object.keys(dependencies).length} runtime deps: ${Object.keys(dependencies).join(", ")})`,
);
