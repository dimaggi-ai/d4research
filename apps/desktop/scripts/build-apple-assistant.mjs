import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
const { values } = parseArgs({
  options: { output: { type: "string" }, arch: { type: "string", default: process.arch } },
});
if (process.platform === "darwin") {
  const source = fileURLToPath(new URL("../native/apple-assistant/main.swift", import.meta.url));
  const output =
    values.output ??
    fileURLToPath(new URL("../resources/apple-assistant/d4-apple-assistant", import.meta.url));
  mkdirSync(dirname(output), { recursive: true });
  const architectures =
    values.arch === "universal"
      ? ["arm64", "x86_64"]
      : [values.arch === "x64" ? "x86_64" : values.arch];
  for (const arch of architectures) {
    if (!["arm64", "x86_64"].includes(arch)) throw new Error("Unsupported Mac architecture");
    execFileSync(
      "xcrun",
      [
        "swiftc",
        "-parse-as-library",
        "-O",
        "-target",
        `${arch}-apple-macos14.0`,
        source,
        "-o",
        architectures.length > 1 ? `${output}-${arch}` : output,
      ],
      { stdio: "inherit" },
    );
  }
  if (architectures.length > 1)
    execFileSync(
      "lipo",
      ["-create", ...architectures.map((arch) => `${output}-${arch}`), "-output", resolve(output)],
      { stdio: "inherit" },
    );
}
