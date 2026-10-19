import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function loadConfig() {
  vi.resetModules();
  return (await import("./app.config")).default;
}

describe("d4 native release isolation", () => {
  it("does not inherit upstream signing or hosted update defaults", async () => {
    for (const name of [
      "T3CODE_IOS_APPLE_TEAM_ID",
      "T3CODE_MOBILE_UPDATES_URL",
      "T3CODE_MOBILE_EAS_PROJECT_ID",
      "T3CODE_MOBILE_EXPO_OWNER",
    ])
      vi.stubEnv(name, "");
    vi.stubEnv("T3CODE_MOBILE_UPDATES_ENABLED", "1");
    vi.stubEnv("APP_VARIANT", "production");
    const config = await loadConfig();
    expect(config.name).toBe("d4research");
    expect(config.ios?.bundleIdentifier).toBe("ai.dimaggi.d4research");
    expect(config.updates?.enabled).toBe(false);
    expect(config.updates?.url).toBeUndefined();
    expect(config.ios?.appleTeamId).toBeUndefined();
    expect(config.extra?.eas).toBeUndefined();
    expect(config.owner).toBeUndefined();
  });

  it("requires an explicit URL and opt-in before enabling OTA updates", async () => {
    vi.stubEnv("T3CODE_MOBILE_UPDATES_URL", "https://updates.example.test/d4");
    vi.stubEnv("T3CODE_MOBILE_UPDATES_ENABLED", "0");
    expect((await loadConfig()).updates?.enabled).toBe(false);
    vi.stubEnv("T3CODE_MOBILE_UPDATES_ENABLED", "1");
    const config = await loadConfig();
    expect(config.updates?.enabled).toBe(true);
    expect(config.updates?.url).toBe("https://updates.example.test/d4");
  });

  it("signs every target under an owned bundle identifier", async () => {
    vi.stubEnv("APP_VARIANT", "production");
    vi.stubEnv("T3CODE_IOS_PERSONAL_TEAM", "");
    vi.stubEnv("T3CODE_IOS_BUNDLE_ID", "com.example.d4");
    const config = await loadConfig();
    expect(config.ios?.bundleIdentifier).toBe("com.example.d4");
    expect(JSON.stringify(config.plugins)).toContain('"com.example.d4.sharing"');
    expect(JSON.stringify(config.plugins)).toContain('"group.com.example.d4"');
  });
});
