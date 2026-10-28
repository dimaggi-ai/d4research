import { assert, describe, it } from "@effect/vitest";
import { parseOsRelease } from "./hostFacts.ts";

const system = { kernel: "7.3.0-5-cachyos", hostname: "cacheos" };

describe("parseOsRelease", () => {
  it("maps an Arch derivative to pacman through ID_LIKE", () => {
    const facts = parseOsRelease(
      'NAME="CachyOS Linux"\nPRETTY_NAME="CachyOS"\nID=cachyos\nID_LIKE=arch\nBUILD_ID=rolling\n',
      system,
    );
    assert.deepEqual(facts, {
      os: "CachyOS",
      osId: "cachyos",
      osLike: ["arch"],
      packageManager: "pacman",
      kernel: "7.3.0-5-cachyos",
      hostname: "cacheos",
    });
  });
  it("maps Debian derivatives to apt and unknown ids to null", () => {
    assert.equal(
      parseOsRelease('ID=ubuntu\nID_LIKE="debian"\nNAME="Ubuntu"', system).packageManager,
      "apt",
    );
    assert.equal(
      parseOsRelease('ID=opensuse-tumbleweed\nID_LIKE="suse opensuse"', system).packageManager,
      "zypper",
    );
    const unknown = parseOsRelease("# nothing useful\n", system);
    assert.isNull(unknown.packageManager);
    assert.equal(unknown.osId, "unknown");
  });
});
