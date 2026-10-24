import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  D4AgentSettings,
} from "@d4research/contracts";
import { applyServerSettingsPatch } from "@d4research/shared/serverSettings";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { withAgentModelOption } from "./D4AgentControls.logic";

const original = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-luna",
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "fastMode", value: true },
  ],
};
function persistSelection(selection: ReturnType<typeof withAgentModelOption>) {
  const updated = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
    d4Agent: { ...DEFAULT_SERVER_SETTINGS.d4Agent, modelSelection: selection },
  });
  return Schema.decodeUnknownSync(D4AgentSettings)(JSON.parse(JSON.stringify(updated.d4Agent)))
    .modelSelection;
}
it("restores provider-default effort without sending an invalid empty option across the settings contract", () => {
  const selected = withAgentModelOption(original, "reasoningEffort", "");
  const saved = persistSelection(selected);
  expect(saved?.options).toEqual([{ id: "fastMode", value: true }]);
  expect(original.options).toContainEqual({ id: "reasoningEffort", value: "high" });
});
it.each(["low", "medium", "high", "xhigh"])(
  "persists the explicitly selected live effort %s and preserves other options",
  (value) => {
    const saved = persistSelection(withAgentModelOption(original, "reasoningEffort", value));
    expect(saved?.instanceId).toBe(original.instanceId);
    expect(saved?.model).toBe(original.model);
    expect(saved?.options).toEqual([
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value },
    ]);
  },
);
