import { expect, it } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { CollapsibleChatImage } from "./CollapsibleChatImage";
const screenshot = (key: string, src = "white.png") => (
  <CollapsibleChatImage imageKey={key} label="Site screenshot">
    <img src={src} alt="Site screenshot" />
  </CollapsibleChatImage>
);
it("removes the bright image and restores it on demand", async () => {
  await using screen = await render(screenshot("toggle"));
  const images = () => screen.container.querySelectorAll("img");
  const toggleButton = () => screen.container.querySelector("button")!;
  expect(images()).toHaveLength(1);
  await act(async () => toggleButton().click());
  expect(images()).toHaveLength(0);
  expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
  await act(async () => toggleButton().click());
  expect(images()).toHaveLength(1);
});
it("stays hidden across row remounts and signed URL refreshes without hiding other images", async () => {
  await using first = await render(screenshot("virtualized"));
  await act(async () => first.container.querySelector("button")!.click());
  await first.unmount();
  await using screen = await render(screenshot("virtualized", "white.png?new-signature"));
  const images = () => screen.container.querySelectorAll("img");
  expect(images()).toHaveLength(0);
  await screen.rerender(screenshot("other-image"));
  expect(images()).toHaveLength(1);
  await screen.rerender(screenshot("virtualized"));
  await act(async () => screen.container.querySelector("button")!.click());
  expect(images()).toHaveLength(1);
});
