/**
 * Asking the CLI beats scanning the filesystem because the catalog honors Grok's own skill
 * config (ignore lists, disabled skills) and includes plugin skills, which live three levels
 * deep under `~/.grok/installed-plugins/` where a flat scan cannot see them.
 */
import type { ServerProviderSkill } from "@d4research/contracts";
import type { GrokSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import { resolveSpawnCommand } from "@d4research/shared/shell";

import { spawnAndCollect } from "@d4research/provider-core/server/snapshotProbe";
import { grokProbeEnvironment } from "./probeEnvironment.ts";

const GROK_SKILLS_PROBE_TIMEOUT_MS = 4_000;

/**
 * Map `grok inspect --json` output onto provider skills. Entries without a
 * name or a filesystem path are skipped; `userInvocable: false` skills are
 * kept but disabled so pickers that filter on `enabled` hide them.
 */
function parseGrokInspectSkills(stdout: string): ReadonlyArray<ServerProviderSkill> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) {
    return [];
  }
  const entries = (parsed as Record<string, unknown>).skills;
  if (!Array.isArray(entries)) {
    return [];
  }

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const source =
      typeof record.source === "object" && record.source !== null
        ? (record.source as Record<string, unknown>)
        : undefined;
    const path = typeof source?.path === "string" ? source.path.trim() : "";
    if (!name || !path) {
      continue;
    }
    const scope = typeof source?.type === "string" ? source.type.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    skillsByName.set(name, {
      name,
      path,
      enabled: record.userInvocable !== false,
      ...(scope ? { scope } : {}),
      ...(description ? { description } : {}),
    });
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export const discoverGrokSkills = Effect.fn("discoverGrokSkills")(function* (
  grokSettings: Pick<GrokSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<
  ReadonlyArray<ServerProviderSkill>,
  never,
  ChildProcessSpawner.ChildProcessSpawner
> {
  const command = grokSettings.binaryPath || "grok";
  const probeEnvironment = grokProbeEnvironment(environment);
  const inspectResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, ["inspect", "--json"], {
      env: probeEnvironment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(cwd ? { cwd } : {}),
        env: probeEnvironment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(GROK_SKILLS_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(inspectResult) || Option.isNone(inspectResult.success)) {
    yield* Effect.logDebug("Grok skill discovery failed; continuing without skills.");
    return [];
  }
  const output = inspectResult.success.value;
  if (output.code !== 0) {
    yield* Effect.logDebug("Grok skill discovery exited non-zero; continuing without skills.", {
      exitCode: output.code,
    });
    return [];
  }
  return parseGrokInspectSkills(output.stdout);
});
