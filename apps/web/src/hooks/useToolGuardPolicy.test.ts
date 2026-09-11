import type { ToolGuardPolicy } from "@d4research/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { requestToolGuardPolicy, saveToolGuardPolicy } from "./useToolGuardPolicy";

const policy: ToolGuardPolicy = {
  policy_id: "d4-policy-test",
  name: "d4 policy test",
  version: 1,
  status: "approved",
  mode: "enforcement",
  scope: { tool_names: ["bash"], tool_groups: ["shell"] },
  rules: [],
};

describe("Tool Guard policy client", () => {
  it("loads the active policy and preserves its source", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, policy, source: "bundled" }));

    await expect(requestToolGuardPolicy(fetcher)).resolves.toEqual({
      ok: true,
      policy,
      source: "bundled",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/tool-guard/policy",
      expect.objectContaining({ credentials: "include", cache: "no-store" }),
    );
  });

  it("does not accept a malformed successful response", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, source: "managed" }));

    await expect(requestToolGuardPolicy(fetcher)).resolves.toEqual({ ok: false });
  });

  it("saves the complete policy and returns the server message", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true, message: "Policy saved." }));

    await expect(saveToolGuardPolicy(policy, fetcher)).resolves.toEqual({
      ok: true,
      message: "Policy saved.",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/tool-guard/policy",
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
        body: JSON.stringify({ policy }),
      }),
    );
  });

  it("keeps an HTTP failure from looking like a successful save", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ ok: true, message: "Rejected." }, { status: 409 }),
    );

    await expect(saveToolGuardPolicy(policy, fetcher)).resolves.toEqual({
      ok: false,
      message: "Rejected.",
    });
  });
});
