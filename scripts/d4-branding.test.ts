import { it } from "vite-plus/test";
import { checkD4Icons } from "./export-d4-icons.ts";

it("keeps every d4 icon and publish-time override in sync with the canonical mark", async () => {
  await checkD4Icons();
});
