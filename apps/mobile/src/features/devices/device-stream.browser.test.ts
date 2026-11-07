import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { start, stop } from "./device-stream.browser";

class Element extends EventTarget {
  readonly style = {};
  naturalWidth = 0;
  naturalHeight = 0;
  src = "";
  readonly tag: string;
  constructor(tag: string) {
    super();
    this.tag = tag;
  }
  setAttribute() {}
  removeAttribute(name: string) {
    if (name === "src") this.src = "";
  }
  append() {}
}

async function setup() {
  vi.useFakeTimers();
  vi.stubGlobal("VideoDecoder", undefined);
  const elements: Element[] = [];
  vi.stubGlobal("document", {
    documentElement: { style: {} },
    body: { style: {}, replaceChildren() {} },
    createElement: (tag: string) => {
      const element = new Element(tag);
      elements.push(element);
      return element;
    },
  });
  const postMessage = vi.fn();
  vi.stubGlobal("window", { ReactNativeWebView: { postMessage }, addEventListener() {} });
  vi.stubGlobal("fetch", () => Promise.resolve(new Response("prime")));
  const sockets: Socket[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: ArrayBuffer }) => void) | null = null;
    close = vi.fn();
    send = vi.fn();
    constructor() {
      sockets.push(this);
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  const configuration = {
    platform: "ios" as const,
    deviceId: "fixture-device",
    access: {
      httpBase: "https://device.test",
      wsBase: "wss://device.test",
      credentials: false,
      query: {},
    },
    colors: {
      background: "white",
      foreground: "black",
      muted: "gray",
      buttonBackground: "gray",
      buttonForeground: "black",
      buttonBorder: "gray",
    },
  };
  start(configuration);
  await vi.advanceTimersByTimeAsync(0);
  return {
    configuration,
    elements,
    sockets,
    messages: () =>
      postMessage.mock.calls.map(
        ([message]) => JSON.parse(message as string) as { type: string; status?: string },
      ),
  };
}

afterEach(() => {
  stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("bridges shared first-frame readiness, image failure, and a successful fresh attempt to native", async () => {
  const { elements, messages, sockets, configuration } = await setup();
  sockets[0]!.onopen?.();
  expect(messages()).not.toContainEqual({ type: "status", status: "streaming" });
  expect(messages()).not.toContainEqual({ type: "input", connected: true });
  sockets[0]!.onmessage?.({ data: new Uint8Array([0x83]).buffer });
  expect(messages()).toContainEqual({ type: "input", connected: true });
  const image = elements.find((element) => element.tag === "img")!;
  image.naturalWidth = 400;
  image.naturalHeight = 800;
  await vi.advanceTimersByTimeAsync(250);
  expect(messages()).toContainEqual({ type: "status", status: "streaming" });
  image.dispatchEvent(new Event("error"));
  expect(messages()).toContainEqual({
    type: "status",
    status: "error",
    detail: "Could not receive the device stream. Reconnect to try again.",
  });
  expect(messages()).toContainEqual({ type: "input", connected: false });
  expect(messages()).not.toContainEqual({ type: "unauthorized" });
  expect(image.src).toBe("");
  expect(sockets[0]!.close).toHaveBeenCalledOnce();
  start(configuration);
  await vi.advanceTimersByTimeAsync(0);
  const replacement = elements.findLast((element) => element.tag === "img")!;
  replacement.naturalWidth = 400;
  replacement.naturalHeight = 800;
  replacement.dispatchEvent(new Event("load"));
  expect(messages().at(-1)).toEqual({ type: "status", status: "streaming" });
  image.dispatchEvent(new Event("error"));
  expect(sockets[1]!.close).not.toHaveBeenCalled();
  stop();
  expect(replacement.src).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});

const envelope = (tag: number, payload: number[]) => {
  const length = 1 + payload.length;
  return [
    length >>> 24,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    tag,
    ...payload,
  ];
};

function viewerFixture(supported: boolean) {
  vi.useFakeTimers();
  const elements: Element[] = [];
  vi.stubGlobal("document", {
    documentElement: { style: {} },
    body: { style: {}, replaceChildren() {} },
    createElement: (tag: string) => {
      const element = new Element(tag);
      elements.push(element);
      return element;
    },
    querySelector: (tag: string) => elements.find((element) => element.tag === tag),
  });
  vi.stubGlobal("window", { ReactNativeWebView: { postMessage() {} }, addEventListener() {} });
  const configured: string[] = [];
  vi.stubGlobal(
    "VideoDecoder",
    class {
      static isConfigSupported = async () => ({ supported });
      state = "unconfigured";
      decodeQueueSize = 0;
      configure(config: VideoDecoderConfig) {
        configured.push(config.codec);
        this.state = "configured";
      }
      decode() {}
      close() {
        this.state = "closed";
      }
    },
  );
  vi.stubGlobal("EncodedVideoChunk", vi.fn());
  vi.stubGlobal(
    "WebSocket",
    class {
      static OPEN = 1;
      readyState = 0;
      send() {}
      close() {}
    },
  );
  const videoBodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  const requested: string[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    requested.push(new URL(url).pathname);
    if (!url.includes("stream.avcc")) return Promise.resolve(new Response(null));
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(body) {
            videoBodies.push(body);
            init.signal?.addEventListener("abort", () => body.error(new Error("aborted")));
          },
        }),
      ),
    );
  });
  vi.stubGlobal("ReactNativeWebView", { postMessage() {} });
  start({
    platform: "ios",
    deviceId: "sim",
    access: {
      httpBase: "https://environment.test/api/device-hub",
      wsBase: "wss://environment.test/api/device-hub",
      credentials: false,
      query: {},
    },
    colors: {
      background: "black",
      foreground: "white",
      muted: "gray",
      buttonBackground: "black",
      buttonForeground: "white",
      buttonBorder: "gray",
    },
  });
  return { configured, requested, videoBodies };
}

describe("native iOS simulator viewer", () => {
  it.each([
    { supported: true, image: "" },
    { supported: false, image: "/api/device-hub/vendor/serve-sim/helper/sim/stream.mjpeg" },
  ])(
    "streams H.264 when WebCodecs decodes it, else MJPEG (supported: $supported)",
    async ({ supported, image }) => {
      try {
        const { configured, requested, videoBodies } = viewerFixture(supported);
        await vi.advanceTimersByTimeAsync(0);
        expect(requested).toContain("/api/device-hub/vendor/serve-sim/helper/sim/stream.avcc");
        videoBodies[0]!.enqueue(new Uint8Array(envelope(1, [1, 0x64, 0x00, 0x33])));
        await vi.advanceTimersByTimeAsync(0);
        expect(configured).toEqual(supported ? ["avc1.640033"] : []);
        const img = document.querySelector("img")!;
        expect(img.src && new URL(img.src).pathname).toBe(image);
        expect(img.style.display).toBe(supported ? "none" : "block");
      } finally {
        stop();
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
  );
});
