import { render } from "../../../test/render";
import { expect, it } from "vite-plus/test";
import { TelemetryExportSettings } from "./TelemetryExportSettings";
it("explains the disabled exporter without offering collector settings", async () => {
  await using screen = await render(<TelemetryExportSettings />);
  expect(screen.container.textContent).toContain(
    "External telemetry exports are disabled in this fork.",
  );
  expect(screen.container.querySelector("input, button[type=submit]")).toBeNull();
});
