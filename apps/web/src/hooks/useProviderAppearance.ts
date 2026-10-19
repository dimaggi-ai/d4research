import type { ProviderInstanceId } from "@d4research/contracts";
import { persistClientSettingsUpdate, useClientSettings } from "./useSettings";
import type { ProviderAppearance } from "../providerAppearance";
import { toastManager } from "../components/ui/toast";

const DEFAULT_APPEARANCE: ProviderAppearance = { modelNames: {} };

export function useProviderAppearance(instanceId: ProviderInstanceId) {
  const appearance = useClientSettings(
    (settings) => settings.providerAppearance[instanceId] ?? DEFAULT_APPEARANCE,
  );
  const update = (change: (current: ProviderAppearance) => ProviderAppearance) => {
    void persistClientSettingsUpdate((settings) => ({
      ...settings,
      providerAppearance: {
        ...settings.providerAppearance,
        [instanceId]: change(settings.providerAppearance[instanceId] ?? DEFAULT_APPEARANCE),
      },
    })).catch(() => {
      toastManager.add({ type: "error", title: "Could not save provider appearance" });
    });
  };
  return { appearance, update };
}
