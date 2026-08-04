import { describe, expect, it } from "@effect/vitest";

import { buildJunieAcpSpawnInput } from "./JunieAcpSupport.ts";
import { resolveAcpAuthMethodId } from "./AcpSessionRuntime.ts";

describe("buildJunieAcpSpawnInput", () => {
  it("starts the default Junie CLI in ACP mode", () => {
    expect(buildJunieAcpSpawnInput(undefined, "/repo")).toEqual({
      command: "junie",
      args: ["--acp=true", "--skip-update-check"],
      cwd: "/repo",
    });
  });

  it("preserves a configured binary and provider environment", () => {
    const env = { JUNIE_API_KEY: "test-key" };
    expect(
      buildJunieAcpSpawnInput(
        { binaryPath: "/opt/junie", defaultModel: "custom:t3-local-ollama" },
        "/repo",
        env,
      ),
    ).toEqual({
      command: "/opt/junie",
      args: ["--acp=true", "--skip-update-check", "--model", "custom:t3-local-ollama"],
      cwd: "/repo",
      env,
    });
  });
});

describe("resolveAcpAuthMethodId", () => {
  it("prefers a provider-specific method", () => {
    expect(resolveAcpAuthMethodId("configured", [{ id: "advertised" }])).toBe("configured");
  });

  it("uses Junie's first advertised method when no id is configured", () => {
    expect(resolveAcpAuthMethodId(undefined, [{ id: "jetbrains-login" }])).toBe("jetbrains-login");
  });

  it("skips authentication when the agent advertises no method", () => {
    expect(resolveAcpAuthMethodId(undefined, [])).toBeUndefined();
  });
});
