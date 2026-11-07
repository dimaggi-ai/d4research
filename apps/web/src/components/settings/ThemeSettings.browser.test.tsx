import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import {
  THEME_HALVES_STORAGE_KEY,
  getStandardThemeColors,
  installCustomTheme,
  removeCustomThemes,
} from "../../themePalette";
import { ThemeLibrary } from "./ThemeSettings";

const THEME_ID = "custom-removal-base";

describe("ThemeLibrary", () => {
  it("keeps a published half that has not streamed in when its base theme is removed", async () => {
    await using stack = new AsyncDisposableStack();
    stack.defer(() => {
      removeCustomThemes([THEME_ID]);
      window.localStorage.removeItem(THEME_HALVES_STORAGE_KEY);
    });
    const customTheme = installCustomTheme({
      id: THEME_ID,
      label: "Removal base",
      appearance: "dark",
      colors: getStandardThemeColors("dark"),
    });
    window.localStorage.setItem(
      THEME_HALVES_STORAGE_KEY,
      JSON.stringify({ light: "published-not-streamed" }),
    );
    const setThemeHalf = vi.fn(() => true);

    await using _ = await render(
      <ThemeLibrary
        theme={customTheme.id}
        setTheme={() => true}
        appearanceMode="system"
        setAppearanceMode={() => true}
        customThemes={[customTheme]}
        initialAppearance="dark"
        refreshTheme={() => {}}
        isImportOpen={false}
        onImportOpenChange={() => {}}
        themeHalves={null}
        setThemeHalf={setThemeHalf}
      />,
    );

    await page.getByRole("button", { name: "Remove Removal base" }).click();
    // Tailwind is not loaded here, so the dialog's backdrop covers its unpositioned popup.
    const confirm = page.getByRole("alertdialog").getByRole("button", { name: "Remove theme" });
    await expect.element(confirm).toBeVisible();
    (confirm.element() as HTMLElement).click();

    expect(setThemeHalf).toHaveBeenCalledWith("light", "published-not-streamed");
  });
});
