import { describe, expect, it, vi } from "vite-plus/test";

import {
  requestSkillInstall,
  requestSkillShare,
  skillsInventoryRequestUrl,
} from "./useSkillsInventory";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const LOCAL_ENVIRONMENT = "http://localhost";

describe("skills inventory mutations", () => {
  it("scopes inventory reads to the selected environment and workspace", () => {
    expect(
      skillsInventoryRequestUrl(
        "/remote/project with spaces",
        "http://100.64.0.40:43123/stale-base",
      ),
    ).toBe("http://100.64.0.40:43123/api/skills?cwd=%2Fremote%2Fproject%20with%20spaces");
  });

  it("does not read or mutate against the browser host while an environment is unresolved", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(skillsInventoryRequestUrl("/remote/project", null)).toBeNull();
    await expect(
      requestSkillInstall({ url: "https://example.test/review.git" }, fetcher),
    ).resolves.toEqual({ ok: false, message: "The selected environment is not connected." });
    await expect(
      requestSkillShare({ sourcePath: "/remote/review", targetRoot: "codex-user" }, fetcher),
    ).resolves.toEqual({ ok: false, message: "The selected environment is not connected." });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("routes mutations to the selected remote environment without leaking its origin", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    await requestSkillInstall(
      {
        url: "https://example.test/review.git",
        httpBaseUrl: "http://100.64.0.40:43123/stale-base",
      },
      fetcher,
    );
    await requestSkillShare(
      {
        sourcePath: "/remote/skills/review",
        targetRoot: "codex-user",
        httpBaseUrl: "http://100.64.0.40:43123/stale-base",
      },
      fetcher,
    );

    expect(calls.map((call) => call.url)).toEqual([
      "http://100.64.0.40:43123/api/skills/install",
      "http://100.64.0.40:43123/api/skills/share",
    ]);
    expect(calls.every((call) => !("httpBaseUrl" in call.body))).toBe(true);
  });

  it("sends the install scope and reports the all-CLI guarantee truthfully", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        ok: true,
        installed: ["review", "verify"],
        sharedRoots: ["claude-user", "junie-user", "agy-user"],
        agyPlugin: "installed",
      }),
    );

    await expect(
      requestSkillInstall(
        {
          url: "https://example.test/skills.git",
          cwd: "/workspace",
          installAgyPlugin: true,
          httpBaseUrl: LOCAL_ENVIRONMENT,
        },
        fetcher,
      ),
    ).resolves.toEqual({
      ok: true,
      message:
        "Installed review, verify for Claude, Codex, Cursor, Grok, OpenCode, Junie and Agy. Agy plugin installed.",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost/api/skills/install",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({
          url: "https://example.test/skills.git",
          cwd: "/workspace",
          installAgyPlugin: true,
        }),
      }),
    );
  });

  it("does not request a whole Agy plugin during a normal portable-skill install", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ installed: ["review"], agyPlugin: "not-requested" }));

    await requestSkillInstall(
      { url: "https://example.test/review.git", httpBaseUrl: LOCAL_ENVIRONMENT },
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost/api/skills/install",
      expect.objectContaining({
        body: JSON.stringify({ url: "https://example.test/review.git" }),
      }),
    );
  });

  it.each([
    ["failed", " Agy plugin install failed."],
    ["agy-unavailable", " Agy not installed on this machine."],
    ["not-a-plugin", ""],
  ])("reports the independent Agy outcome %s", async (agyPlugin, suffix) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ installed: ["review"], agyPlugin }));
    await expect(
      requestSkillInstall(
        { url: "https://example.test/review.git", httpBaseUrl: LOCAL_ENVIRONMENT },
        fetcher,
      ),
    ).resolves.toEqual({
      ok: true,
      message: `Installed review for Claude, Codex, Cursor, Grok, OpenCode, Junie and Agy.${suffix}`,
    });
  });

  it("uses the server error message and falls back safely for malformed errors", async () => {
    await expect(
      requestSkillInstall(
        { url: "file:///tmp/nope", httpBaseUrl: LOCAL_ENVIRONMENT },
        vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ message: "Rejected URL." }, 400)),
      ),
    ).resolves.toEqual({ ok: false, message: "Rejected URL." });
    await expect(
      requestSkillInstall(
        { url: "https://example.test/x.git", httpBaseUrl: LOCAL_ENVIRONMENT },
        vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 500)),
      ),
    ).resolves.toEqual({ ok: false, message: "Could not install the skill." });
  });

  it("reports the exact share target and propagates server conflicts", async () => {
    await expect(
      requestSkillShare(
        {
          sourcePath: "/skills/review",
          targetRoot: "junie-user",
          httpBaseUrl: LOCAL_ENVIRONMENT,
        },
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(jsonResponse({ targetPath: "/junie/skills/review" })),
      ),
    ).resolves.toEqual({ ok: true, message: "Shared to /junie/skills/review" });
    await expect(
      requestSkillShare(
        {
          sourcePath: "/skills/review",
          targetRoot: "junie-user",
          httpBaseUrl: LOCAL_ENVIRONMENT,
        },
        vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ message: "Already exists." }, 409)),
      ),
    ).resolves.toEqual({ ok: false, message: "Already exists." });
  });
});
