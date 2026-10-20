import * as NodeModule from "node:module";
import { type ConfigPlugin, type ExportedConfig, withEntitlementsPlist } from "expo/config-plugins";
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
  it("signs with the d4 team and does not inherit hosted update defaults", async () => {
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
    expect(config.ios?.appleTeamId).toBe("CR2PTQ345T");
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

describe("Personal Team entitlement cleanup", () => {
  it("removes capabilities added by later plugins while preserving the signing identity", async () => {
    vi.stubEnv("T3CODE_IOS_PERSONAL_TEAM", "1");
    vi.stubEnv("T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID", "com.example.personal");
    vi.stubEnv("T3CODE_IOS_APPLE_TEAM_ID", "TESTTEAM01");
    const config = await loadConfig();
    const cleanupPath = "./plugins/withoutIosPersonalTeamCapabilities.cjs";
    expect(config.plugins?.[0]).toBe(cleanupPath);
    expect(config.ios?.appleTeamId).toBe("TESTTEAM01");
    expect(config.ios?.bundleIdentifier).toBe("com.example.personal");
    const cleanup = NodeModule.createRequire(import.meta.url)(cleanupPath) as ConfigPlugin;
    const configured = withEntitlementsPlist(cleanup(config), (modConfig) => {
      Object.assign(modConfig.modResults, {
        "aps-environment": "development",
        "com.apple.developer.applesignin": ["Default"],
        "com.apple.developer.associated-domains": ["applinks:example.test"],
        "com.apple.security.application-groups": ["group.com.example.personal"],
        "com.apple.developer.team-identifier": "TESTTEAM01",
      });
      return modConfig;
    });
    const run = (configured as ExportedConfig).mods?.ios?.entitlements;
    expect(run).toBeDefined();
    if (!run) throw new Error("Missing entitlement mod");
    const result = await run({
      ...configured,
      modResults: {},
      modRawConfig: config,
      modRequest: {
        projectRoot: "/test/project",
        platformProjectRoot: "/test/project/ios",
        platform: "ios",
        modName: "entitlements",
        introspect: true,
      },
    });
    expect(result.modResults).toEqual({
      "com.apple.developer.team-identifier": "TESTTEAM01",
    });
  });

  it("does not register capability cleanup for paid-team builds", async () => {
    vi.stubEnv("T3CODE_IOS_PERSONAL_TEAM", "");
    expect((await loadConfig()).plugins).not.toContain(
      "./plugins/withoutIosPersonalTeamCapabilities.cjs",
    );
  });
});
