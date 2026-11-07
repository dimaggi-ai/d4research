import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Layer from "effect/Layer";
import * as ExpoCrypto from "expo-crypto";

export const cryptoLayer = Layer.succeed(
  SecureRandom.SecureRandom,
  SecureRandom.make(ExpoCrypto.getRandomBytes),
);
