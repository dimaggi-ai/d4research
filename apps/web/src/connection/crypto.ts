import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Layer from "effect/Layer";

export const cryptoLayer = Layer.succeed(
  SecureRandom.SecureRandom,
  SecureRandom.make((size) => globalThis.crypto.getRandomValues(new Uint8Array(size))),
);
