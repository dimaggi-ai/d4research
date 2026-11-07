import { describe, expect, it } from "vite-plus/test";

import { readDefaultMobileThemeVariables } from "./mobileTheme.test-support";
import {
  getMobileThemeVariables,
  MOBILE_THEME_IDS,
  themeColorWithAlpha,
  flattenThemeColor,
  themeColorContrastRatio,
  type MobileThemeVariables,
} from "./mobileTheme";
import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";

const SELECTION_ROLES = [
  "--color-thread-selected",
  "--color-thread-selected-foreground",
  "--color-thread-selected-foreground-muted",
] as const;
const CARD_TEXT_ROLES = [
  "--color-foreground-secondary",
  "--color-foreground-muted",
  "--color-placeholder",
  "--color-primary-text",
] as const;
const stablePalette = (variables: MobileThemeVariables, android = false) => {
  const adaptedRoles = new Set<string>([
    ...SELECTION_ROLES,
    ...(android ? ["--color-grouped-card", ...CARD_TEXT_ROLES] : []),
  ]);
  return Object.fromEntries(Object.entries(variables).filter(([role]) => !adaptedRoles.has(role)));
};

function expectReadableSelection(variables: MobileThemeVariables) {
  const selected = variables["--color-thread-selected"];
  expect(
    themeColorContrastRatio(
      selected,
      flattenThemeColor(variables["--color-drawer"], variables["--color-screen"]),
    ),
  ).toBeGreaterThanOrEqual(1.2);
  for (const role of SELECTION_ROLES.slice(1)) {
    expect(themeColorContrastRatio(variables[role], selected)).toBeGreaterThanOrEqual(4.5);
  }
}

function expectReadableCard(variables: MobileThemeVariables, darkAndroid: boolean) {
  const card = variables["--color-grouped-card"];
  for (const role of CARD_TEXT_ROLES) {
    expect(themeColorContrastRatio(variables[role], card)).toBeGreaterThanOrEqual(4.5);
  }
  expect(themeColorContrastRatio(card, variables["--color-sheet-solid"])).toBeGreaterThanOrEqual(
    1.025,
  );
  if (darkAndroid) {
    for (const surface of [
      variables["--color-screen"],
      flattenThemeColor(variables["--color-header"], variables["--color-screen"]),
    ]) {
      expect(themeColorContrastRatio(card, surface)).toBeGreaterThanOrEqual(1.2);
    }
  }
}

describe("mobile theme runtime variables", () => {
  it("matches the standard base palette to the generated stylesheet", () => {
    for (const appearance of ["light", "dark"] as const) {
      expectReadableSelection(getMobileThemeRuntimeVariables("t3-code", appearance, "web"));
    }
    expect(stablePalette(getMobileThemeRuntimeVariables("t3-code", "light", "web"))).toEqual(
      stablePalette(readDefaultMobileThemeVariables("light")),
    );
    expect(stablePalette(getMobileThemeRuntimeVariables("t3-code", "dark", "web"))).toEqual(
      stablePalette(readDefaultMobileThemeVariables("dark")),
    );
  });

  it("uses the same shared palette source as generated custom themes", () => {
    expect(getMobileThemeRuntimeVariables("ocean", "light", "ios")).toEqual(
      getMobileThemeVariables("ocean", "light"),
    );
    expect(getMobileThemeRuntimeVariables("iris", "dark", "ios")).toEqual(
      getMobileThemeVariables("iris", "dark"),
    );
  });

  it.each(MOBILE_THEME_IDS)(
    "uses a screen-colored %s sidebar beneath an opaque Android frame",
    (themeId) => {
      for (const appearance of ["light", "dark"] as const) {
        const base = getMobileThemeVariables(
          themeId === "material-you" ? "t3-code" : themeId,
          appearance,
        );
        const android = getMobileThemeRuntimeVariables(themeId, appearance, "android");
        expectReadableSelection(android);
        expectReadableCard(android, appearance === "dark");
        if (appearance === "light")
          expect(android["--color-grouped-card"]).toBe(base["--color-grouped-card"]);
        expect(stablePalette(android, true)).toEqual(
          stablePalette(
            {
              ...base,
              "--color-header": themeColorWithAlpha(
                base[
                  themeId === "t3-code" || themeId === "material-you"
                    ? "--color-row-hover"
                    : "--color-drawer"
                ],
                1,
              ),
              "--color-header-foreground": base["--color-drawer-foreground"],
              "--color-drawer": base["--color-screen"],
            },
            true,
          ),
        );
        expect(android["--color-header"]).toMatch(/^rgba\(\d+, \d+, \d+, 1\)$/);
      }
    },
  );

  it.each(["t3-code", "material-you"] as const)(
    "keeps the %s default Material frame distinct in both appearances",
    (themeId) => {
      for (const appearance of ["light", "dark"] as const) {
        const variables = getMobileThemeRuntimeVariables(themeId, appearance, "android");
        expect(variables["--color-header"]).toBe(
          appearance === "light" ? "rgba(244, 244, 245, 1)" : "rgba(20, 20, 20, 1)",
        );
        for (const pane of ["--color-screen", "--color-sheet-solid", "--color-drawer"] as const) {
          expect(variables["--color-header"]).not.toBe(themeColorWithAlpha(variables[pane], 1));
        }
      }
    },
  );

  it.each(["t3-code", "material-you"] as const)(
    "adapts %s iPad chrome without reversing the dark desktop hierarchy",
    (themeId) => {
      for (const appearance of ["light", "dark"] as const) {
        const ios = getMobileThemeRuntimeVariables(themeId, appearance, "ios");
        const android = getMobileThemeRuntimeVariables(themeId, appearance, "android");
        if (appearance === "light") {
          expect(ios["--color-drawer"]).toBe(android["--color-header"]);
          expect(ios["--color-header"]).toBe(android["--color-header"]);
          expect(ios["--color-header-foreground"]).toBe(ios["--color-drawer-foreground"]);
        } else {
          expect(ios).toEqual(getMobileThemeVariables("t3-code", appearance));
          expect(ios["--color-drawer"]).toBe("#000000");
          expect(ios["--color-thread-canvas"]).toBe("#0a0a0a");
        }
        expectReadableCard(ios, false);
        expectReadableCard(android, appearance === "dark");
        expect(ios["--color-grouped-card"]).toBe(
          getMobileThemeVariables("t3-code", appearance)["--color-grouped-card"],
        );
        if (appearance === "light")
          expect(ios["--color-grouped-card"]).toBe(android["--color-grouped-card"]);
        expect(themeColorWithAlpha(ios["--color-thread-hover"], 1)).not.toBe(
          themeColorWithAlpha(ios["--color-drawer"], 1),
        );
        expect(themeColorWithAlpha(ios["--color-thread-hover"], 1)).not.toBe(
          themeColorWithAlpha(ios["--color-thread-selected"], 1),
        );
        for (const role of [
          "--color-screen",
          "--color-thread-canvas",
          "--color-card",
          "--color-composer-surface",
        ] as const) {
          expect(ios[role]).toBe(android[role]);
        }
      }
    },
  );
});
