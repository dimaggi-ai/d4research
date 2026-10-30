import * as FileSystem from "effect/FileSystem";
/**
 * Usage history for Claude Code: the transcript format of its
 * `<home>/projects/**.jsonl` session files and where each instance keeps them.
 *
 * @module provider/Drivers/claudeUsage
 */

import type { ClaudeSettings } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "@d4research/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@d4research/provider-core/server/usage";
import * as HostProcess from "@d4research/shared/HostProcess";

// Claude Code uses this model for local placeholders that never reached the API.
export const CLAUDE_SYNTHETIC_MODEL = "<synthetic>";

/**
 * T3 Code writes one record per assistant *content block*, and every one of those records repeats
 * the same complete `usage` object for the parent message. Summing them overcounts by roughly
 * 2.4x on a real workload, so the caller must drop repeats by `dedupeKey` and keep the first.
 */
export function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parseClaudeRecord(parsed);
}

function parseClaudeRecord(parsed: unknown): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0 || model === CLAUDE_SYNTHETIC_MODEL) return null;

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: {
      uncachedInputTokens: tokenCount(usageRecord["input_tokens"]),
      cachedInputTokens: tokenCount(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: tokenCount(usageRecord["cache_creation_input_tokens"]),
      outputTokens: tokenCount(usageRecord["output_tokens"]),
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    speed: usageRecord["speed"] === "fast" ? "fast" : "standard",
    dedupeKey,
  };
}

const orEmpty = (record: UsageRecord | null): readonly UsageRecord[] =>
  record === null ? [] : [record];

export const claudeUsageFormat: TranscriptUsageFormat<void> = {
  selectFields: {
    type: true,
    timestamp: true,
    requestId: true,
    sessionId: true,
    costUSD: true,
    message: { id: true, model: true, usage: true },
  },
  usageMarkers: ['"usage"'],
  parseLine: (line) => orEmpty(parseClaudeLine(line)),
  parseProjected: (projected) => orEmpty(parseClaudeRecord(projected)),
};

export const claudeUsageReader: ProviderUsageReader<
  ClaudeSettings,
  Path.Path | FileSystem.FileSystem
> = {
  kind: "transcripts",
  provider: "claude",
  format: claudeUsageFormat,
  directories: Effect.fn("claudeUsageReader.directories")(function* ({ config, environment }) {
    if (config === undefined) return [];
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const configured = config.configDir.trim();
    const processHome = config.homePath.trim()
      ? expandHomePath(config.homePath.trim(), homeDirectory)
      : environment.HOME?.trim() || homeDirectory;
    let home = configured
      ? expandHomePath(configured, homeDirectory)
      : environment.CLAUDE_CONFIG_DIR?.trim() || path.join(processHome, ".claude");
    // Older fork builds could bind HOME directly to a Claude configuration folder.
    if (!configured && !environment.CLAUDE_CONFIG_DIR?.trim() && config.homePath.trim()) {
      const fs = yield* FileSystem.FileSystem;
      if (
        !(yield* fs.exists(path.join(home, "projects")).pipe(Effect.orElseSucceed(() => false))) &&
        (yield* fs
          .exists(path.join(processHome, "projects"))
          .pipe(Effect.orElseSucceed(() => false)))
      )
        home = processHome;
    }
    return [{ dir: path.resolve(home, "projects") }];
  }),
};
