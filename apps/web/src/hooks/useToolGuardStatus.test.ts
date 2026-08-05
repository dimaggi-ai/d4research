import { describe, expect, it, vi } from "vite-plus/test";

import { requestToolGuardLifecycleAction } from "./useToolGuardStatus";

describe("Tool Guard lifecycle client", () => {
  it.each(["install", "replace-external", "enable", "disable", "uninstall"] as const)(
    "sends the %s action to the environment server",
    async (action) => {
      const fetcher = vi.fn(async () => Response.json({ ok: true, message: `${action} complete` }));
      await expect(requestToolGuardLifecycleAction(action, fetcher)).resolves.toEqual({
        ok: true,
        message: `${action} complete`,
      });
      expect(fetcher).toHaveBeenCalledWith(
        "/api/tool-guard/status",
        expect.objectContaining({
          method: "POST",
          credentials: "include",
          body: JSON.stringify({ action }),
        }),
      );
    },
  );

  it("returns the server failure message", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ ok: false, message: "Core is missing" }, { status: 409 }),
    );
    await expect(requestToolGuardLifecycleAction("install", fetcher)).resolves.toEqual({
      ok: false,
      message: "Core is missing",
    });
  });
});
