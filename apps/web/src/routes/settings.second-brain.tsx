import { createFileRoute } from "@tanstack/react-router";
import { SecondBrainSettingsPanel } from "../components/settings/SecondBrainSettingsPanel";

export const Route = createFileRoute("/settings/second-brain")({
  component: SecondBrainSettingsPanel,
});
