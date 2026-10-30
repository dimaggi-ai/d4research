import { Config } from "@opencode/schema/config";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { OpenCodeSettings } from "../settings.ts";
import { withOpenCodeConfigEnvironment } from "./OpenCodeRuntime.ts";

const decodeSettings = Schema.decodeUnknownSync(OpenCodeSettings);
const decodeOpenCode2Config = Schema.decodeUnknownSync(Config.Info);
const config = {
  provider: {
    local: {
      npm: "@ai-sdk/openai-compatible" as const,
      name: "Local",
      options: { baseURL: "http://127.0.0.1:8080/v1" },
      models: { model: { name: "Model", limit: { context: 250_000, output: 8_192 } } },
    },
  },
};

describe("OpenCode instance config", () => {
  it("preserves provider config and the 250000-token context through settings decoding", () => {
    expect(decodeSettings({ config }).config).toEqual(config);
    expect(decodeSettings({}).config).toEqual({ provider: {} });
  });

  it("rejects unsupported packages and invalid context limits", () => {
    expect(() =>
      decodeSettings({
        config: { provider: { local: { ...config.provider.local, npm: "other" } } },
      }),
    ).toThrow();
    expect(() =>
      decodeSettings({
        config: {
          provider: {
            local: {
              ...config.provider.local,
              models: { model: { limit: { context: 0, output: 8192 } } },
            },
          },
        },
      }),
    ).toThrow();
  });

  it("overlays explicit providers while preserving other environment config", () => {
    const environment = {
      PATH: "/bin",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        instructions: ["AGENTS.md"],
        provider: { existing: { npm: "existing" }, local: { npm: "replaced" } },
      }),
    };
    const resolved = withOpenCodeConfigEnvironment(environment, config);
    expect(resolved.PATH).toBe("/bin");
    expect(JSON.parse(resolved.OPENCODE_CONFIG_CONTENT!)).toEqual({
      instructions: ["AGENTS.md"],
      provider: { existing: { npm: "existing" }, ...config.provider },
    });
    expect(JSON.parse(environment.OPENCODE_CONFIG_CONTENT).provider.local.npm).toBe("replaced");
  });

  it("translates custom providers to the installed OpenCode 2 config schema", () => {
    const resolved = withOpenCodeConfigEnvironment({}, config, "v2");
    const native = JSON.parse(resolved.OPENCODE_CONFIG_CONTENT!);
    const decoded = decodeOpenCode2Config(native);
    expect(decoded.providers?.local?.package).toBe("@opencode/ai/providers/openai-compatible");
    expect(decoded.providers?.local?.settings).toEqual({
      baseURL: "http://127.0.0.1:8080/v1",
      provider: "local",
    });
    expect(decoded.providers?.local?.models?.model?.limit?.context).toBe(250_000);
    expect(native.provider).toBeUndefined();
  });

  it("leaves an empty config and an explicitly isolated environment unchanged", () => {
    const environment = {};
    expect(withOpenCodeConfigEnvironment(environment, { provider: {} })).toBe(environment);
    expect(
      JSON.parse(withOpenCodeConfigEnvironment(environment, config).OPENCODE_CONFIG_CONTENT!),
    ).toEqual(config);
  });

  it("rejects malformed environment config rather than silently discarding it", () => {
    expect(() => withOpenCodeConfigEnvironment({ OPENCODE_CONFIG_CONTENT: "{" }, config)).toThrow();
    expect(() =>
      withOpenCodeConfigEnvironment({ OPENCODE_CONFIG_CONTENT: "null" }, config),
    ).toThrow();
  });
});
