import { type DesktopBridge } from "@d4research/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@d4research/contracts";
import { type ConfirmDialogOptions, type ContextMenuItem } from "@d4research/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();
const dismissContextMenuMock = vi.fn<() => void>();

const requestConfirmDialogMock =
  vi.fn<(message: string, options?: ConfirmDialogOptions) => Promise<boolean> | undefined>();

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
  dismissContextMenu: dismissContextMenuMock,
}));

vi.mock("./confirmDialog", () => ({
  requestConfirmDialog: requestConfirmDialogMock,
}));

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function testWindow(): Window & typeof globalThis {
  return globalThis.window ?? (globalThis as unknown as Window & typeof globalThis);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  if (globalThis.window === undefined) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
  }
  Reflect.deleteProperty(testWindow(), "desktopBridge");
  Object.defineProperty(testWindow(), "localStorage", {
    configurable: true,
    value: createLocalStorageStub(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LocalApi", () => {
  it("fails closed in a browser when no themed host is available", async () => {
    requestConfirmDialogMock.mockReturnValue(undefined);
    const { createLocalApi } = await import("./localApi");

    await expect(createLocalApi().dialogs.confirm("Delete this thread?")).resolves.toBe(false);
  });

  it("rejects opening System Settings when the desktop bridge is unavailable", async () => {
    const { createLocalApi } = await import("./localApi");

    await expect(createLocalApi().shell.openSystemSettings("full-disk-access")).rejects.toThrow(
      "Unable to open System Settings.",
    );
  });

  it("delegates host capabilities and persistence to the desktop bridge", async () => {
    const showContextMenu = vi.fn().mockResolvedValue("delete");
    const pickFolder = vi.fn().mockResolvedValue("/tmp/project");
    const getClientSettings = vi.fn().mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
    const setClientSettings = vi.fn().mockResolvedValue(undefined);
    testWindow().desktopBridge = {
      showContextMenu,
      pickFolder,
      getClientSettings,
      setClientSettings,
    } as unknown as DesktopBridge;

    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi();
    requestConfirmDialogMock.mockReturnValue(undefined);
    await expect(api.dialogs.confirm("Install update?")).resolves.toBe(false);
    await expect(api.dialogs.pickFolder({ initialPath: "/tmp" })).resolves.toBe("/tmp/project");
    await expect(api.persistence.getClientSettings()).resolves.toEqual(DEFAULT_CLIENT_SETTINGS);
    await api.persistence.setClientSettings(DEFAULT_CLIENT_SETTINGS);

    expect(showContextMenu).not.toHaveBeenCalled();
    expect(pickFolder).toHaveBeenCalledWith({ initialPath: "/tmp" });
    expect(getClientSettings).toHaveBeenCalledTimes(1);
    expect(setClientSettings).toHaveBeenCalledWith(DEFAULT_CLIENT_SETTINGS);
  });

  it("persists client settings in browser storage", async () => {
    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi();
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      timestampFormat: "12-hour" as const,
    };

    await api.persistence.setClientSettings(settings);
    await expect(api.persistence.getClientSettings()).resolves.toEqual(settings);
  });
});
