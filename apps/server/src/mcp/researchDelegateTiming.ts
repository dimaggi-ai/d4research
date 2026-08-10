export const RESEARCH_DELEGATE_TIMEOUT_ENV = "T3_RESEARCH_DELEGATE_TIMEOUT_MS";
export const DEFAULT_RESEARCH_DELEGATE_TIMEOUT_MILLIS = 1_800_000;
export const RESEARCH_DELEGATE_MCP_TIMEOUT_MARGIN_MILLIS = 60_000;

type TimeoutEnvironment = Readonly<Record<string, string | undefined>>;

/** Resolve the server-side ceiling for one delegated turn. */
export function resolveResearchDelegateTimeoutMillis(
  environment: TimeoutEnvironment = globalThis.process?.env ?? {},
): number {
  const raw = environment[RESEARCH_DELEGATE_TIMEOUT_ENV];
  if (raw === undefined) return DEFAULT_RESEARCH_DELEGATE_TIMEOUT_MILLIS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RESEARCH_DELEGATE_TIMEOUT_MILLIS;
}

/**
 * The MCP caller must outlive the delegated turn so the handler can return its
 * own bounded timeout result. The margin covers serialization and cleanup.
 */
export function resolveResearchDelegateMcpTimeoutSeconds(
  environment: TimeoutEnvironment = globalThis.process?.env ?? {},
): number {
  return Math.ceil(
    (resolveResearchDelegateTimeoutMillis(environment) +
      RESEARCH_DELEGATE_MCP_TIMEOUT_MARGIN_MILLIS) /
      1_000,
  );
}
