import { SecondBrainError } from "@d4research/contracts";

const patterns = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{16,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
  /\bxox[bp]-[A-Za-z0-9-]{16,}\b/g,
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi,
  /\b(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_KEY)[A-Z0-9_]*\s*=\s*["']?[^\s"']{16,}["']?/gim,
];
export function redactSecrets(text: string) {
  return patterns.reduce((value, pattern) => value.replace(pattern, "[REDACTED]"), text);
}
export function assertNoSecrets(text: string) {
  if (redactSecrets(text) !== text) throw new SecondBrainError({ code: "secret_detected" });
}
