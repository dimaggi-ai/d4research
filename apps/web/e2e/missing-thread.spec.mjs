import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { createPairingUrl, openProject } from "./harness.mjs";

// A PWA relaunches on its last URL. When that thread was deleted meanwhile the
// client must redirect to a fresh draft instead of looping on navigate("/")
// until the renderer dies, which is what locked the iPhone out of the app.
export async function missingThreadRedirect({ page, app }) {
  const workspace = NodePath.join(app.baseDir, "missing-thread-workspace");
  await NodeFSP.mkdir(workspace, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(workspace, "README.md"), "# fixture\n");
  await page.goto(createPairingUrl(app, "missing-thread"), { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Toggle main sidebar", exact: true }).waitFor();
  await openProject(page, workspace);
  const environment = await (await fetch(`${app.webUrl}/.well-known/t3/environment`)).json();
  const missingUrl = `${app.webUrl}/${environment.environmentId}/9b1e7a3c-0000-4000-8000-0000000000aa`;

  for (const attempt of ["in-app", "cold-start"]) {
    await page.goto(missingUrl, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/draft\//, { timeout: 20_000 });
    await page.locator('[data-chat-composer-form="true"]').waitFor({ state: "visible" });
    // A hung main thread never answers this call; the harness deadline would
    // report it, but a direct probe gives a clearer failure.
    const probe = await Promise.race([
      page.evaluate(() => location.pathname),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Renderer unresponsive after ${attempt} open`)), 10_000),
      ),
    ]);
    NodeAssert.match(probe, /^\/draft\//, `${attempt}: expected a draft route, got ${probe}`);
  }
}
