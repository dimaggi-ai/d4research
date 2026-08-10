// @effect-diagnostics nodeBuiltinImport:off, globalConsoleInEffect:off, globalConsole:off, globalDateInEffect:off, outdatedApi:off
/**
 * Records a real Claude CLI session as a replayable fixture.
 *
 * Adapter unit tests drive a hand-written fake, so they only ever reproduce
 * message shapes we already imagined. Real failures (a stop that returns an
 * `[ede_diagnostic]`-only result, an aborted tool call, a rate limit) have
 * shapes nobody wrote down. This captures the actual SDK message stream so
 * those shapes become regression fixtures.
 *
 * Usage:
 *   vp tsx scripts/record-claude-fixture.ts <name> "<prompt>" [--interrupt-after-ms N]
 *
 * Writes a sanitized fixture that retains SDK control-flow shape while
 * discarding prompts, tool inputs, paths, identifiers, and provider text.
 * Inspect the result before committing it.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";

import {
  claudeFixtureFileName,
  sanitizeClaudeFixtureMessages,
} from "../apps/server/src/provider/Layers/claudeFixtureSanitizer.ts";

const FIXTURE_DIR = NodePath.join(
  import.meta.dirname,
  "../apps/server/src/provider/Layers/__fixtures__/claude",
);

function parseArgs() {
  const [name, prompt, ...rest] = process.argv.slice(2);
  if (!name || !prompt) {
    console.error('Usage: record-claude-fixture.ts <name> "<prompt>" [--interrupt-after-ms N]');
    process.exit(1);
  }
  const flagIndex = rest.indexOf("--interrupt-after-ms");
  const interruptAfterMs =
    flagIndex >= 0 && rest[flagIndex + 1] ? Number(rest[flagIndex + 1]) : undefined;
  return { name, prompt, interruptAfterMs };
}

async function main() {
  const { name, prompt, interruptAfterMs } = parseArgs();
  const messages: Array<unknown> = [];

  const session = query({
    prompt,
    options: { permissionMode: "bypassPermissions" },
  });

  if (interruptAfterMs !== undefined) {
    setTimeout(() => {
      console.log(`[recorder] interrupting after ${interruptAfterMs}ms`);
      void session.interrupt();
    }, interruptAfterMs);
  }

  try {
    for await (const message of session) {
      messages.push(message);
      console.log(`[recorder] ${(message as { type?: string }).type ?? "unknown"}`);
    }
  } catch (cause) {
    // A thrown stream is itself a shape worth recording.
    messages.push({
      __recorderStreamError: cause instanceof Error ? cause.message : String(cause),
    });
    console.log("[recorder] stream threw; recorded as __recorderStreamError");
  }

  await NodeFSP.mkdir(FIXTURE_DIR, { recursive: true });
  const target = NodePath.join(FIXTURE_DIR, claudeFixtureFileName(name));
  const sanitized = sanitizeClaudeFixtureMessages(messages);
  await NodeFSP.writeFile(target, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
  console.log(`[recorder] wrote ${messages.length} messages to ${target}`);
}

await main();
