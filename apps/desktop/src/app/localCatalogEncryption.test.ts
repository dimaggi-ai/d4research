import { assert, describe, it } from "@effect/vitest";

import { decryptLocalCatalog, encryptLocalCatalog } from "./localCatalogEncryption.ts";

describe("local connection catalog encryption", () => {
  const key = new Uint8Array(32).fill(19);
  const nonce = new Uint8Array(12).fill(7);
  const value = '{"credential":"test-only-secret","label":"Mac Mini"}';

  it("round-trips the catalog without storing plaintext", () => {
    const encrypted = encryptLocalCatalog(value, key, nonce);
    assert.equal(decryptLocalCatalog(encrypted, key), value);
    assert.notInclude(new TextDecoder().decode(encrypted), "test-only-secret");
  });

  it("uses the nonce to produce different ciphertext", () => {
    assert.notDeepEqual(
      encryptLocalCatalog(value, key, nonce),
      encryptLocalCatalog(value, key, new Uint8Array(12).fill(8)),
    );
  });

  it("rejects a changed nonce, tag or ciphertext and a wrong key", () => {
    const encrypted = encryptLocalCatalog(value, key, nonce);
    for (const offset of [0, 12, encrypted.length - 1]) {
      const changed = Uint8Array.from(encrypted);
      changed[offset] = changed[offset]! ^ 1;
      assert.throws(() => decryptLocalCatalog(changed, key));
    }
    assert.throws(() => decryptLocalCatalog(encrypted, new Uint8Array(32).fill(20)));
  });

  it("rejects invalid key, nonce and payload lengths", () => {
    assert.throws(() => encryptLocalCatalog(value, new Uint8Array(16), nonce));
    assert.throws(() => encryptLocalCatalog(value, key, new Uint8Array(8)));
    assert.throws(() => decryptLocalCatalog(new Uint8Array(27), key));
  });
});
