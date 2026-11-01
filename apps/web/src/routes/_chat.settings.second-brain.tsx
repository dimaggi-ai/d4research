import { createFileRoute } from "@tanstack/react-router";
import { SecondBrainSettingsPanel } from "../components/settings/SecondBrainSettingsPanel";

export const Route = createFileRoute("/_chat/settings/second-brain")({
  component: SecondBrainSettingsPanel,
});
