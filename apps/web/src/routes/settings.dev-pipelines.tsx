import { createFileRoute } from "@tanstack/react-router";

import { DevPipelinesSettingsPanel } from "../components/settings/DevPipelinesSettingsPanel";

function SettingsDevPipelinesRoute() {
  return <DevPipelinesSettingsPanel />;
}

export const Route = createFileRoute("/settings/dev-pipelines")({
  component: SettingsDevPipelinesRoute,
});
