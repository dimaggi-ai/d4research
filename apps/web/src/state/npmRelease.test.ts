import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import { isNpmReleasePublished } from "./npmRelease";

const version = "0.0.46-nightly.20261012.3021";

// FetchHttpClient reads globalThis.fetch once and keeps it, so every test shares this mock.
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

describe("isNpmReleasePublished", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("checks npm without tracing headers, so the browser skips the preflight npm rejects", async () => {
    fetchMock.mockImplementation(async () => Response.json({ version }));

    const result = await isNpmReleasePublished(version);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = new Request(fetchMock.mock.calls[0]?.[0] ?? "", fetchMock.mock.calls[0]?.[1]);
    expect(request.url).toBe(`https://registry.npmjs.org/d4research/${version}`);
    expect(request.headers.get("traceparent")).toBeNull();
    expect(request.headers.get("b3")).toBeNull();
    expect(result).toBe(true);
  });

  // regression: #18709 update-everything skipped npm-installed servers
  it("leaves a failed first check unknown, which callers read as unpublished", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(isNpmReleasePublished(version)).rejects.toThrow();
  });
});
