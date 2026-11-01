import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const RESUMABLE_SESSIONS_MAX_LIMIT = 200;

/**
 * A coding-agent session that exists on disk for a repository and can be continued ("resumed") in
 * t3. These are discovered from the provider CLIs' own session stores (Claude Code, Codex) so a
 * conversation started in the CLI shows up here, and continuing it in t3 writes back to the same
 * session file — round-tripping between the CLI and t3.
 */
export const ResumableSessionStatus = Schema.Literals(["active", "idle"]);
export type ResumableSessionStatus = typeof ResumableSessionStatus.Type;

export const ResumableSession = Schema.Struct({
  /** Stable, unique key for the row: `${providerInstanceId}:${sessionId}`. */
  key: TrimmedNonEmptyString,
  /** Driver that owns the session (e.g. "claudeAgent", "codex"). */
  provider: ProviderDriverKind,
  /** The configured instance whose store the session came from. */
  providerInstanceId: ProviderInstanceId,
  /** Human label for the source instance (e.g. "Claude Work", "Codex"). */
  providerLabel: TrimmedNonEmptyString,
  /** Provider session id (Claude session UUID; Codex thread/rollout id). */
  sessionId: TrimmedNonEmptyString,
  /** Model slug the session last used, when recoverable from the store (used to preset the picker). */
  model: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * Opaque resume cursor passed straight to the provider when continuing: a bare session-id string
   * for Claude, or `{ threadId }` for Codex. The web echoes this back unmodified on turn start.
   */
  resumeCursor: Schema.Unknown,
  /** First user prompt / summary, used as the row title. */
  title: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
  messageCount: NonNegativeInt,
  /** Best-effort liveness: "active" when the session file changed very recently, else "idle". */
  status: ResumableSessionStatus,
});
export type ResumableSession = typeof ResumableSession.Type;

export const ListResumableSessionsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ListResumableSessionsInput = typeof ListResumableSessionsInput.Type;

export const ListResumableSessionsResult = Schema.Struct({
  sessions: Schema.Array(ResumableSession),
  truncated: Schema.Boolean,
});
export type ListResumableSessionsResult = typeof ListResumableSessionsResult.Type;

export class ListResumableSessionsError extends Schema.TaggedError<ListResumableSessionsError>()(
  "ListResumableSessionsError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export { RESUMABLE_SESSIONS_MAX_LIMIT };
