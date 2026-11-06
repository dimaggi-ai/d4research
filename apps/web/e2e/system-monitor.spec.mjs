import * as NodeAssert from "node:assert/strict";
import * as NodePath from "node:path";

export async function systemMonitor({ page, webUrl, screenshotDir }) {
  await page.goto(webUrl, { waitUntil: "domcontentloaded" });
  const resume = page.getByRole("button", { name: "Resume from CLI", exact: true });
  await resume.waitFor();
  NodeAssert.equal(await resume.count(), 1);
  NodeAssert.equal(await resume.getAttribute("aria-expanded"), "false");
  await resume.click();
  await page.getByText("No CLI sessions for this repo", { exact: true }).first().waitFor();
  await resume.click();
  NodeAssert.equal(await resume.getAttribute("aria-expanded"), "false");
  NodeAssert.equal(await page.getByRole("button", { name: "Dashboard", exact: true }).count(), 0);
  NodeAssert.equal(await page.locator('a[href="/dashboard"]').count(), 0);
  const samples = [];
  page.on("response", (response) => {
    const request = response.request();
    if (new URL(request.url()).pathname === "/api/system-monitor")
      samples.push(request.timing().startTime);
  });
  const responsePromise = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/system-monitor",
  );
  await page.goto(`${webUrl}/system`, { waitUntil: "domcontentloaded" });
  const response = await responsePromise;
  NodeAssert.equal(response.status(), 200);
  const snapshot = await response.json();
  NodeAssert.ok(snapshot.mem.total > 0);
  NodeAssert.ok(
    snapshot.cpu.overall === null || (snapshot.cpu.overall >= 0 && snapshot.cpu.overall <= 100),
  );
  await page.getByText("Environments", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Refresh system status", exact: true }).waitFor();
  await page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/system-monitor",
  );
  NodeAssert.ok(
    samples[1] - samples[0] >= 1_800,
    "Rendering a response must not restart the polling timer",
  );
  await page.screenshot({ path: NodePath.join(screenshotDir, "system-monitor-macos.png") });
  await page.route("**/api/system-monitor", (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .getByText("System status is unavailable. Check the environment connection and try again.", {
      exact: true,
    })
    .waitFor();
  await page.getByText("Environments", { exact: true }).waitFor();
  NodeAssert.equal(
    await page.getByText("Check mission-control.service.", { exact: false }).count(),
    0,
  );
}
