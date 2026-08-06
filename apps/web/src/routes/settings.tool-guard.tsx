import { createFileRoute } from "@tanstack/react-router";

import { ToolGuardSettingsPanel } from "../components/settings/ToolGuardSettingsPanel";

function SettingsToolGuardRoute() {
  return <ToolGuardSettingsPanel />;
}

export const Route = createFileRoute("/settings/tool-guard")({
  component: SettingsToolGuardRoute,
});
