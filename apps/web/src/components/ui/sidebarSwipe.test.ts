import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { installSidebarSwipe } from "./sidebarSwipe";

class TestElement {
  parentElement = null;
  scrollWidth = 100;
  clientWidth = 100;
  sidebar = false;
  interactive = false;
  dialog = false;
  closest(selector: string) {
    if (selector.includes("data-sidebar")) return this.sidebar ? this : null;
    if (selector.includes("input")) return this.interactive ? this : null;
    if (selector.includes("dialog")) return this.dialog ? this : null;
    return null;
  }
}

let document: Document;
let element: TestElement;
let cleanup: (() => void) | undefined;
beforeEach(() => {
  document = new EventTarget() as Document;
  element = new TestElement();
  vi.stubGlobal("Element", TestElement);
  vi.stubGlobal("getComputedStyle", () => ({ overflowX: "auto" }));
});
afterEach(() => {
  cleanup?.();
  vi.unstubAllGlobals();
});

function touch(type: string, x: number, y = 100, count = 1) {
  const point = { identifier: 1, clientX: x, clientY: y };
  const event = new Event(type, { cancelable: true });
  Object.defineProperties(event, {
    target: { value: element },
    touches: { value: type === "touchend" ? [] : Array.from({ length: count }, () => point) },
    changedTouches: { value: [point] },
  });
  document.dispatchEvent(event);
  return event;
}

function setup(open = false) {
  const onOpenChange = vi.fn();
  cleanup = installSidebarSwipe(document, { open, onOpenChange });
  return onOpenChange;
}

describe("mobile sidebar swipe", () => {
  it("opens with an inward swipe near the left edge", () => {
    const change = setup();
    touch("touchstart", 30);
    expect(touch("touchmove", 60).defaultPrevented).toBe(true);
    touch("touchend", 120);
    expect(change).toHaveBeenCalledExactlyOnceWith(true);
  });
  it("closes with an outward swipe inside the drawer", () => {
    element.sidebar = true;
    const change = setup(true);
    touch("touchstart", 220);
    touch("touchend", 120);
    expect(change).toHaveBeenCalledExactlyOnceWith(false);
  });
  it("leaves vertical scrolling alone even if the finger later drifts sideways", () => {
    const change = setup();
    touch("touchstart", 30);
    expect(touch("touchmove", 35, 140).defaultPrevented).toBe(false);
    touch("touchend", 180, 160);
    expect(change).not.toHaveBeenCalled();
  });
  it.each([0, 8, 80, 200])("does not claim browser-back or central swipes at x=%s", (x) => {
    const change = setup();
    touch("touchstart", x);
    touch("touchend", x + 100);
    expect(change).not.toHaveBeenCalled();
  });
  it.each(["interactive", "dialog", "horizontal-scroll"])("does not claim %s gestures", (kind) => {
    element.interactive = kind === "interactive";
    element.dialog = kind === "dialog";
    if (kind === "horizontal-scroll") element.scrollWidth = 400;
    const change = setup();
    touch("touchstart", 30);
    touch("touchend", 140);
    expect(change).not.toHaveBeenCalled();
  });
  it("ignores taps, short drags, canceled gestures, and multi-touch", () => {
    const change = setup();
    touch("touchstart", 30);
    touch("touchend", 35);
    touch("touchstart", 30);
    touch("touchcancel", 100);
    touch("touchend", 140);
    touch("touchstart", 30);
    touch("touchmove", 100, 100, 2);
    touch("touchend", 140);
    expect(change).not.toHaveBeenCalled();
  });
  it("removes its listeners when leaving mobile layout", () => {
    const change = setup();
    cleanup?.();
    touch("touchstart", 30);
    touch("touchend", 140);
    expect(change).not.toHaveBeenCalled();
  });
});
