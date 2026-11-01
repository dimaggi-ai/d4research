import { createFileRoute } from "@tanstack/react-router";

import { ResearchSettingsPanel } from "../components/settings/ResearchSettingsPanel";

function SettingsResearchRoute() {
  return <ResearchSettingsPanel />;
}

export const Route = createFileRoute("/_chat/settings/research")({
  component: SettingsResearchRoute,
});
