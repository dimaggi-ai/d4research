import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { AppRouteModal } from "./AppRouteModal";

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

describe("AppRouteModal", () => {
  it("keeps navigation outside the pane accessible without dismissing settings", async () => {
    const onNavigate = vi.fn();
    await using _screen = await render(
      <>
        <button onClick={onNavigate}>Open navigation</button>
        <AppRouteModal label="Settings">
          <input aria-label="Instructions" />
        </AppRouteModal>
      </>,
      { router: "/settings/general" },
    );

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep this draft");
    await page.getByRole("button", { name: "Open navigation" }).click();
    expect(onNavigate).toHaveBeenCalledOnce();
    await expect.element(page.getByRole("textbox", { name: "Instructions" })).toHaveValue("Keep this draft");
  });

  it("keeps the settings pane inside the app content lane", async () => {
    await using screen = await render(
      <div style={{ display: "flex", width: 600, height: 400, marginTop: 80 }}>
        <nav aria-label="Main navigation" style={{ width: 200, flexShrink: 0 }}>
          Navigation
        </nav>
        <AppRouteModal label="Settings">
          <input aria-label="Instructions" />
        </AppRouteModal>
      </div>,
      { router: "/settings/general" },
    );

    await expect.element(page.getByRole("textbox", { name: "Instructions" })).toBeVisible();
    const navigation = screen.container.querySelector('nav')!.getBoundingClientRect();
    const pane = page.getByRole("dialog", { name: "Settings" }).element().getBoundingClientRect();
    expect(pane.left).toBeGreaterThanOrEqual(navigation.right);
    expect(pane.top).toBeGreaterThanOrEqual(navigation.top);
    expect(pane.width).toBeLessThanOrEqual(400);
  });

  it("commits a focused field when Esc closes it", async () => {
    const onCommit = vi.fn();
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <CommitOnBlurField onCommit={onCommit} />
      </AppRouteModal>,
      { router: "/settings/general" },
    );

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
  });
});
