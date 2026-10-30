// @effect-diagnostics nodeBuiltinImport:off - Effect Crypto provides randomness/digests, not AES-GCM.
import * as NodeCrypto from "node:crypto";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const AAD = Buffer.from("t3code:local-connection-catalog:v1");

/** A nonce, authentication tag and ciphertext; the caller supplies fresh cryptographic randomness. */
export function encryptLocalCatalog(value: string, key: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (key.length !== 32 || nonce.length !== NONCE_BYTES) {
    throw new Error("Invalid local connection encryption key or nonce length.");
  }
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
}

export function decryptLocalCatalog(encrypted: Uint8Array, key: Uint8Array): string {
  if (key.length !== 32 || encrypted.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error("Invalid local connection encryption key or payload length.");
  }
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    key,
    encrypted.subarray(0, NONCE_BYTES),
    {
      authTagLength: TAG_BYTES,
    },
  );
  decipher.setAAD(AAD);
  decipher.setAuthTag(encrypted.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
  return Buffer.concat([
    decipher.update(encrypted.subarray(NONCE_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString("utf8");
}
