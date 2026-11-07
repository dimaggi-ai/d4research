import { RegistryContext } from "@effect/atom-react";
import { useLocation } from "@tanstack/react-router";
import type { EnvironmentId } from "@d4research/contracts";
import { useContext, useEffect, useState } from "react";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { almanac } from "../../state/almanac";
import { useEnvironmentQuery } from "../../state/query";
import { secondBrain } from "../../state/second-brain";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { MemoryLibrary } from "./MemoryLibrary";
import { ReviewInbox, SecondBrainConfiguration } from "./SecondBrainSettingsPanel";
import { SettingsPageContainer } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

type Tab = "library" | "review" | "settings";

// Settings search links to sections inside the Review and Settings tabs.
const TAB_FOR_HASH: Readonly<Record<string, Tab>> = {
  "second-brain-inbox": "review",
  "research-second-brain": "settings",
};

export function MemorySettingsPanel() {
  const { target } = useSettingsScope();
  return target ? (
    <MemoryPanel key={target.environmentId} environmentId={target.environmentId} />
  ) : (
    <SettingsPageContainer>
      <p>Select a connected environment.</p>
    </SettingsPageContainer>
  );
}

function MemoryPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const registry = useContext(RegistryContext);
  const settings = useEnvironmentSettings(environmentId);
  const status = useEnvironmentQuery(secondBrain.secondBrainStatusQuery(environmentId));
  const almanacStatus = useEnvironmentQuery(almanac.almanacStatusQuery(environmentId));
  const hash = useLocation({ select: (location) => location.hash.replace(/^#/, "") });
  const linkedTab = TAB_FOR_HASH[hash];
  const [chosenTab, setChosenTab] = useState<Tab>("library");
  // The settings container clears the hash once it finds the target, so the choice must outlive it.
  if (linkedTab && linkedTab !== chosenTab) setChosenTab(linkedTab);
  const tab = linkedTab ?? chosenTab;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the window focus listener; notes and Almanac change outside this client.
  useEffect(() => {
    const refresh = () => {
      secondBrain.refresh(environmentId, registry);
      almanac.refresh(environmentId, registry);
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [environmentId, registry]);
  const notesEnabled = Boolean(settings.secondBrain.path);
  const almanacConnected = almanacStatus.data?.connected ?? false;
  const summary = [
    notesEnabled ? `${status.data?.notes ?? "…"} notes` : "Notes off",
    !almanacStatus.data
      ? "Checking Almanac…"
      : almanacConnected
        ? "Almanac connected"
        : almanacStatus.data.configured
          ? "Almanac unreachable"
          : "Almanac not set up",
  ].join(" · ");
  return (
    <SettingsPageContainer width="wide">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          aria-label="Memory view"
          variant="segmented"
          value={[tab]}
          onValueChange={(next) => {
            if (next[0] === "library" || next[0] === "review" || next[0] === "settings")
              setChosenTab(next[0]);
          }}
        >
          <ToggleGroupItem value="library">Library</ToggleGroupItem>
          <ToggleGroupItem value="review">Review</ToggleGroupItem>
          <ToggleGroupItem value="settings">Settings</ToggleGroupItem>
        </ToggleGroup>
        <p className="text-sm text-muted-foreground">{summary}</p>
      </div>
      {tab === "library" && (
        <MemoryLibrary
          environmentId={environmentId}
          notesEnabled={notesEnabled}
          almanacEnabled={almanacStatus.data?.configured ?? false}
        />
      )}
      {tab === "review" && (
        <ReviewInbox key={settings.secondBrain.path} environmentId={environmentId} />
      )}
      {tab === "settings" && (
        <SecondBrainConfiguration
          environmentId={environmentId}
          almanacConnected={almanacConnected}
        />
      )}
    </SettingsPageContainer>
  );
}
