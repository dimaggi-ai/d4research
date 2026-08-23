import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@d4research/marketing...'",
  buildCommand: "vp run --filter @d4research/marketing build",
  outputDirectory: "dist",
};
