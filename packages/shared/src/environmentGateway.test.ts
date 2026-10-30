import { describe, expect, it } from "vite-plus/test";
import { environmentGatewayPath, environmentResourceUrl } from "./environmentGateway.ts";

const gateway = "https://mac.tail.test/api/shared-environments/proxy/mini";
describe("shared environment resources", () => {
  it("recognizes only the host gateway and keeps normal server origins unchanged", () => {
    expect(environmentGatewayPath(gateway + "/")).toBe("/api/shared-environments/proxy/mini");
    for (const base of ["https://mac.test", "https://mac.test/random", gateway + "/other"]) {
      expect(environmentGatewayPath(base)).toBe("");
    }
    expect(environmentResourceUrl("https://mini.test/", "/api/assets/42?token=example")).toBe(
      "https://mini.test/api/assets/42?token=example",
    );
  });
  it.each([
    "/api/assets/42?token=example",
    "api/assets/42?token=example",
    "/assets/42?token=example",
  ])("routes %s to the selected environment", (resource) => {
    expect(environmentResourceUrl(gateway, resource)).toBe(
      gateway + "/" + resource.replace(/^\//u, ""),
    );
  });
  it("does not duplicate a prefix or rewrite external and inline media", () => {
    expect(environmentResourceUrl(gateway, gateway + "/api/assets/42")).toBe(
      gateway + "/api/assets/42",
    );
    expect(environmentResourceUrl(gateway, "https://cdn.test/image.png")).toBe(
      "https://cdn.test/image.png",
    );
    expect(environmentResourceUrl(gateway, "data:image/png;base64,YQ==")).toBe(
      "data:image/png;base64,YQ==",
    );
  });
});
