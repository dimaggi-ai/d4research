import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const SOURCE_ROOT = NodePath.dirname(new URL(import.meta.url).pathname);
// Only the Android menu imports this, and Android loads the base module.
const ANDROID_ONLY_EXPORTS = new Set(["components/ui/AppSymbol.ios.tsx: isAppSymbolName"]);

function sourceFiles(directory: string): ReadonlyArray<string> {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function runtimeExports(path: string): ReadonlySet<string> {
  const source = NodeFS.readFileSync(path, "utf8");
  const names = new Set<string>();
  for (const match of source.matchAll(
    /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|enum)\s+([\w$]+)/gm,
  ))
    names.add(match[1]!);
  if (/^export\s+default\b/m.test(source)) names.add("default");
  for (const match of source.matchAll(/^export\s+\{([^}]*)\}/gm))
    for (const specifier of match[1]!.split(",")) {
      const name = specifier.trim();
      if (name && !name.startsWith("type ")) names.add(name.split(/\s+as\s+/).at(-1)!);
    }
  return names;
}

// TypeScript checks imports against the base file, but Metro loads the platform file, so a name
// missing from a variant compiles and then fails at runtime on that platform only.
it("exports every runtime name of the base module from each platform variant", () => {
  const files = sourceFiles(SOURCE_ROOT);
  const known = new Set(files);
  const missing = files.flatMap((variant) => {
    const base = variant.replace(/\.(ios|android)\.tsx?$/, "");
    if (base === variant) return [];
    const basePath = [`${base}.ts`, `${base}.tsx`].find((path) => known.has(path));
    if (!basePath) return [];
    const exported = runtimeExports(variant);
    return [...runtimeExports(basePath)]
      .filter((name) => !exported.has(name))
      .map((name) => `${NodePath.relative(SOURCE_ROOT, variant)}: ${name}`)
      .filter((entry) => !ANDROID_ONLY_EXPORTS.has(entry));
  });
  expect(missing).toEqual([]);
});
