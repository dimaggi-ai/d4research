import { sha256 } from "@noble/hashes/sha2";

export function sha256Hex(value: string): string {
  return Array.from(sha256(new TextEncoder().encode(value)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
