import { useCSSVariable } from "uniwind";
import defaultThemeVariables from "../../generated-uniwind-default-theme-variables.json";
import type { MobileThemeVariables } from "./mobileTheme";

const variableNames = Object.keys(defaultThemeVariables.light);

/** Reads the active CSS palette, including d4's current native theme overrides. */
export function useUniwindTheme(): MobileThemeVariables {
  const values = useCSSVariable(variableNames);
  return Object.fromEntries(
    variableNames.map((name, index) => [name, String(values[index] ?? "")]),
  );
}
