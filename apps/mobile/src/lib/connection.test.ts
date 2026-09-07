import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@d4research/contracts";

import {
  isRelayManagedConnection,
  authClientMetadata,
  toStableSavedRemoteConnection,
} from "./connection";

vi.mock("./runtime", () => ({
  runtime: {
    runPromise: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  Platform: {
    OS: "ios",
  },
}));

describe("mobile remote connection records", () => {
  it("identifies mobile token exchanges for authorized-client presentation", () => {
    expect(authClientMetadata()).toEqual({
      label: "T3 Code Mobile",
      deviceType: "mobile",
      os: "iOS",
    });
  });

  it("recognizes explicitly managed relay connections", () => {
    expect(isRelayManagedConnection({ relayManaged: true })).toBe(true);
  });

  it("keeps existing DPoP tunnel records read-only after upgrading", () => {
    expect(isRelayManagedConnection({ authenticationMethod: "dpop" })).toBe(true);
    expect(isRelayManagedConnection({ authenticationMethod: "bearer" })).toBe(false);
  });

  it("drops short-lived managed environment credentials from stable records", () => {
    const connection = {
      environmentId: EnvironmentId.make("environment-1"),
      environmentLabel: "Desktop",
      pairingUrl: "https://desktop.example/",
      displayUrl: "https://desktop.example/",
      httpBaseUrl: "https://desktop.example/",
      wsBaseUrl: "wss://desktop.example/",
      bearerToken: null,
      authenticationMethod: "dpop",
      dpopAccessToken: "short-lived-token",
      relayManaged: true,
    } as const;

    expect(toStableSavedRemoteConnection(connection)).not.toHaveProperty("dpopAccessToken");
  });
});
