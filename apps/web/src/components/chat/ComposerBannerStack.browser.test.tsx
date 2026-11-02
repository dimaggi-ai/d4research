import "../../index.css";

import type { ReactNode } from "react";
import { page, userEvent } from "vite-plus/test/browser";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { render as renderComponent } from "../../../test/render";
import { ComposerBanner } from "./ComposerBanner";
import { ComposerBannerStack, NoticeText } from "./ComposerBannerStack";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const nextFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));

async function render(width: number, description: string) {
  container.style.width = `${width}px`;
  await act(async () =>
    root.render(
      <ComposerBannerStack
        items={[{ id: "usage", variant: "info", icon: null, title: "Usage limits", description }]}
      />,
    ),
  );
  await nextFrame();
}

const hasDetails = () => container.querySelector('[aria-label="Show notice details"]') !== null;

it("only offers notice details when the description cannot fit", async () => {
  await render(700, "OpenCode");
  expect(hasDetails()).toBe(false);

  await render(700, "OpenCode ".repeat(40));
  expect(hasDetails()).toBe(true);

  container.style.width = "4000px";
  await nextFrame();
  expect(hasDetails()).toBe(false);

  await render(4000, "OpenCode");
  expect(hasDetails()).toBe(false);

  // A narrow composer hides the description entirely, so details are the only way to read it.
  container.style.width = "300px";
  await nextFrame();
  expect(hasDetails()).toBe(true);
});

function noticeRow(width: string, children: ReactNode) {
  return (
    <div data-testid="row" className="flex items-center gap-1.5" style={{ width }}>
      <NoticeText detailsLabel="Show details" className="min-w-0 truncate">
        {children}
      </NoticeText>
    </div>
  );
}

it("leaves out the details button when only a link's hit area reaches past the text", async () => {
  // Phones lay out in device pixels, so a range can measure one float32 step (2^-17 px at
  // this size) wider than its element. Headless Chromium's rects agree exactly.
  const rangeRect = Range.prototype.getBoundingClientRect;
  using _rangeRect = vi
    .spyOn(Range.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Range) {
      const rect = rangeRect.call(this);
      return new DOMRect(rect.x, rect.y, rect.width + 2 ** -17, rect.height);
    });
  // The flicker is a details button that mounts and then unmounts, so record every insertion.
  const inserted: Node[] = [];
  using observing = new DisposableStack();
  const mutations = new MutationObserver((records) =>
    inserted.push(...records.flatMap((record) => [...record.addedNodes])),
  );
  mutations.observe(document.body, { childList: true, subtree: true });
  observing.defer(() => mutations.disconnect());
  await using screen = await renderComponent(
    noticeRow(
      "20rem",
      <>
        Needs input{" "}
        <button type="button" className="relative after:absolute after:-inset-x-10 after:inset-y-0">
          Review
        </button>
      </>,
    ),
  );

  await expect.element(screen.getByText("Review")).toBeVisible();
  const details = [
    ...inserted,
    ...mutations.takeRecords().flatMap((record) => [...record.addedNodes]),
  ].filter(
    (node) =>
      node instanceof Element &&
      (node.matches('[aria-label="Show details"]') ||
        node.querySelector('[aria-label="Show details"]')),
  );
  expect(details).toEqual([]);
});

it("shows the details button while text or nested text is cut, until it fits again", async () => {
  await using screen = await renderComponent(
    noticeRow("4rem", "Waiting on a subagent with a long name"),
  );
  const details = screen.getByRole("button", { name: "Show details" });
  await expect.element(details).toBeInTheDocument();

  await screen.rerender(noticeRow("4rem", "Ready"));
  await expect.element(details).not.toBeInTheDocument();

  await screen.rerender(noticeRow("4rem", "Waiting on a subagent with a long name"));
  await expect.element(details).toBeInTheDocument();

  screen.getByTestId("row").element().style.width = "40rem";
  await expect.element(details).not.toBeInTheDocument();

  await screen.rerender(
    noticeRow(
      "40rem",
      <span className="inline-block max-w-16 truncate align-bottom">A long nested name</span>,
    ),
  );
  await expect.element(details).toBeInTheDocument();

  await screen.rerender(
    <ComposerBanner.Root>
      {noticeRow("4rem", "Waiting on a subagent with a long name")}
    </ComposerBanner.Root>,
  );
  await expect.element(details).toBeInTheDocument();
  await screen.rerender(<ComposerBanner.Root>{noticeRow("4rem", "Ready")}</ComposerBanner.Root>);
  await expect.element(details).not.toBeInTheDocument();
});

it("opens the details of a long notice right above its button", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1280, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const script = Array.from({ length: 400 }, (_, line) => `echo "line ${line}"`).join("\n");
  const container = document.createElement("div");
  container.style.cssText = "position: fixed; bottom: 4rem; right: 4rem;";
  await using screen = await renderComponent(noticeRow("40rem", script), { container });
  const details = screen.getByRole("button", { name: "Show details" });
  await userEvent.hover(details);
  const popup = page.getByLabelText("Notice details");
  await expect.element(popup).toBeVisible();

  // A positioner sized to the unscrolled text flips beside the button and covers it.
  await vi.waitFor(() => {
    const gap =
      details.element().getBoundingClientRect().top -
      popup.element().getBoundingClientRect().bottom;
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(8);
  });
});
