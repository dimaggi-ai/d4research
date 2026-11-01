import { expect, it, vi } from "vite-plus/test";
import { stubGlobal } from "../test/render";
import { installMobileViewport } from "./mobileViewport";
function setup() {
  const resources = new DisposableStack();
  const viewport = Object.assign(new EventTarget(), { height: 852, offsetTop: 0, scale: 1 });
  let nextFrame: FrameRequestCallback | null = null;
  resources.use(stubGlobal("visualViewport", viewport));
  resources.use(stubGlobal("innerHeight", 852));
  resources.use(
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      nextFrame = callback;
      return 1;
    }),
  );
  resources.use(
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {
      nextFrame = null;
    }),
  );
  const dispose = installMobileViewport(window);
  resources.defer(dispose);
  return {
    viewport,
    dispose,
    get nextFrame() {
      return nextFrame;
    },
    flush() {
      const callback = nextFrame;
      nextFrame = null;
      callback?.(0);
    },
    [Symbol.dispose]() {
      resources.dispose();
    },
  };
}
it("follows keyboard shrink and subsequent Safari panning without another resize", () => {
  using fixture = setup();
  const { viewport, flush, dispose } = fixture;
  viewport.height = 420;
  viewport.dispatchEvent(new Event("resize"));
  flush();
  expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("420px");
  expect(document.documentElement.style.getPropertyValue("--app-safe-area-bottom")).toBe("0px");
  viewport.offsetTop = 432;
  viewport.dispatchEvent(new Event("scroll"));
  flush();
  expect(document.documentElement.style.getPropertyValue("--app-viewport-top")).toBe("432px");
  viewport.offsetTop = 0;
  viewport.height = 852;
  viewport.dispatchEvent(new Event("resize"));
  flush();
  expect(document.documentElement.style.getPropertyValue("--app-viewport-top")).toBe("0px");
  expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("852px");
  expect(document.documentElement.style.getPropertyValue("--app-safe-area-bottom")).toBe(
    "env(safe-area-inset-bottom)",
  );
});
it("coalesces keyboard animation events and cancels pending work on unmount", () => {
  using fixture = setup();
  const { viewport, flush, dispose } = fixture;
  viewport.dispatchEvent(new Event("scroll"));
  viewport.dispatchEvent(new Event("resize"));
  expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
  dispose();
  flush();
  expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("");
  viewport.dispatchEvent(new Event("scroll"));
  expect(fixture.nextFrame).toBeNull();
});
it("leaves magnification to the browser and resumes after zoom ends", () => {
  using fixture = setup();
  const { viewport, flush, dispose } = fixture;
  viewport.scale = 2;
  viewport.height = 210;
  viewport.offsetTop = 50;
  viewport.dispatchEvent(new Event("resize"));
  flush();
  expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("852px");
  viewport.scale = 1;
  viewport.height = 420;
  viewport.dispatchEvent(new Event("resize"));
  flush();
  expect(document.documentElement.style.getPropertyValue("--app-viewport-top")).toBe("50px");
});
