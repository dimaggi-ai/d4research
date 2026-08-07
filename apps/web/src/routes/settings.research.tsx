import { createFileRoute } from "@tanstack/react-router";

import { ResearchSettingsPanel } from "../components/settings/ResearchSettingsPanel";

function SettingsResearchRoute() {
  return <ResearchSettingsPanel />;
}

export const Route = createFileRoute("/settings/research")({
  component: SettingsResearchRoute,
});
