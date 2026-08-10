const SAFE_STRUCTURAL_STRING_KEYS = new Set(["type", "subtype", "stop_reason"]);
const IDENTIFIER_KEYS = new Set(["id", "uuid", "session_id", "parent_tool_use_id", "tool_use_id"]);
const SAFE_STRUCTURAL_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function sanitizedProviderError(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes("[ede_diagnostic]")) return "[ede_diagnostic] details redacted";
  if (lower.includes("rate limit")) return "Rate limit exceeded. Please retry later.";
  if (lower.includes("timeout") || lower.includes("timed out")) return "Provider timed out.";
  return "[redacted provider error]";
}

function sanitizeFixtureValue(value: unknown, key: string | undefined): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    if (key !== undefined && SAFE_STRUCTURAL_STRING_KEYS.has(key)) {
      return SAFE_STRUCTURAL_VALUE.test(value) ? value : "redacted";
    }
    if (key !== undefined && IDENTIFIER_KEYS.has(key)) {
      return value.length === 0 ? value : `fixture-${key.replaceAll("_", "-")}`;
    }
    if (key === "model") return "fixture-model";
    if (key === "errors") return sanitizedProviderError(value);
    if (key === "__recorderStreamError") return "[redacted stream error]";
    return "[redacted fixture text]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeFixtureValue(entry, key));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        entryKey === "input"
          ? { __fixtureRedacted: true }
          : sanitizeFixtureValue(entryValue, entryKey),
      ]),
    );
  }
  return undefined;
}

/** Removes all user-authored strings while retaining SDK control-flow shape. */
export function sanitizeClaudeFixtureMessages(
  messages: ReadonlyArray<unknown>,
): ReadonlyArray<unknown> {
  return messages.map((message) => sanitizeFixtureValue(message, undefined));
}

export function claudeFixtureFileName(name: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/u.test(name)) {
    throw new Error("Fixture name must contain only lowercase letters, digits, and hyphens.");
  }
  return `${name}.json`;
}
