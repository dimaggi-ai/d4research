import { describe, expect, it } from "vite-plus/test";

import { sha256Hex } from "./hash.ts";

describe("sha256Hex", () => {
  it("returns a lowercase SHA-256 digest", () => {
    expect(sha256Hex("d4research")).toBe(
      "274bb2ae36f7015d0a30927b30bf0988ab138752039080e9f65bd9fae1b2cb87",
    );
  });
});
