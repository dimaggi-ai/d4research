import { RuntimeRequestId } from "@d4research/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

it("shows the agent's reason with the full request in the composer approval drawer", async () => {
  const command = Array.from({ length: 40 }, (_, line) => `echo step-${line + 1}`).join(" && ");
  await using screen = await render(
    <ComposerPendingApprovalPanel
      approval={{
        requestId: RuntimeRequestId.make("request-1"),
        requestKind: "command",
        createdAt: "2026-11-12T10:00:00.000Z",
        detail: command,
        reason: "The backup marker is stale, so this resumes the preserved staging.",
        responseCapability: "live",
      }}
      pendingCount={1}
    />,
    { router: false },
  );
  expect(screen.container.querySelector('[aria-label="Reason"]')?.textContent).toBe(
    "The backup marker is stale, so this resumes the preserved staging.",
  );
  expect(screen.container.querySelector('[aria-label="Command"]')?.textContent).toBe(command);
});
