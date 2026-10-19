import type { ProviderDriverKind, ProviderInstanceId } from "@d4research/contracts";
import { useProviderAppearance } from "~/hooks/useProviderAppearance";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "./providerDriverMeta";
import { Button } from "../ui/button";

export function ProviderAppearanceSettings(props: {
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  displayName: string;
}) {
  const { appearance, update } = useProviderAppearance(props.instanceId);
  const options = providerClients.definitions.map((provider) => ({
    value: provider.driverKind,
    label: provider.label,
  }));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">Icons</span>
        <ProviderInstanceIcon {...props} className="size-6" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        {(["icon", "badgeIcon"] as const).map((field) => (
          <label key={field} className="space-y-1 text-xs text-muted-foreground">
            <span>{field === "icon" ? "Main icon" : "Small badge icon"}</span>
            <select
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground"
              value={appearance[field] ?? "default"}
              onChange={(event) => {
                const value = event.target.value;
                update((current) => {
                  const next = { ...current };
                  if (value === "default") delete next[field];
                  else next[field] = value;
                  return next;
                });
              }}
            >
              <option value="default">Default</option>
              {field === "badgeIcon" ? (
                <>
                  <option value="none">None</option>
                  <option value="initials">Initials</option>
                </>
              ) : null}
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Display preferences for this provider on this client.
      </p>
      {appearance.icon || appearance.badgeIcon || Object.keys(appearance.modelNames).length > 0 ? (
        <Button size="sm" variant="ghost" onClick={() => update(() => ({ modelNames: {} }))}>
          Reset icons and model names
        </Button>
      ) : null}
    </div>
  );
}
