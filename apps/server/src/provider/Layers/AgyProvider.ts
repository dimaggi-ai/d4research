import {
  type AgySettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PRESENTATION = {
  displayName: "Agy",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
// `agy models` can initialize connector state on a cold process. Keep the
// Settings probe bounded, but give that first discovery enough time to finish.
const PROBE_TIMEOUT_MS = 20_000;

// CSI sequences, OSC sequences (BEL- or ST-terminated), two-byte escapes like
// `ESC(B`/`ESC7`, and stray C0 control characters other than \t. Matching
// control characters is the entire point here — the CLI emits them.
const ANSI_ESCAPE_REGEX =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[0-9A-Za-z=<>]|[\x00-\x08\x0b-\x1f\x7f]/gu;

// Model slugs are plain machine identifiers. Anything else — stderr prose
// merged in by the PTY wrapper, spinner frames, escape residue — must never
// become a selectable model.
const MODEL_SLUG_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export const quotePosixShellArgument = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function parseAgyModelsOutput(stdout: string): ReadonlyArray<{
  readonly slug: string;
  readonly name: string;
}> {
  const results: Array<{ slug: string; name: string }> = [];
  for (const rawLine of stdout.split(/\r?\n/u)) {
    // Agy prints a spinner that rewrites the current line via bare `\r`.
    // Parse every `\r` segment rather than only the final one, so a row that
    // shares a physical line with spinner frames still gets picked up — slug
    // validation below rejects the frames themselves.
    for (const segment of rawLine.split("\r")) {
      const cleaned = segment.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
      if (!cleaned) continue;
      // Agy formats rows as `slug   Description` with runs of spaces padding
      // the slug column, so split on 2-or-more whitespace.
      const [slug, ...rest] = cleaned.split(/\s{2,}/u);
      if (!slug || !MODEL_SLUG_REGEX.test(slug)) continue;
      const name = rest.join(" ").trim() || slug;
      results.push({ slug, name });
    }
  }
  return results;
}

function modelsFromDiscovered(
  discovered: ReadonlyArray<{ readonly slug: string; readonly name: string }>,
  settings: AgySettings,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const { slug, name } of discovered) {
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
      ...(slug === settings.defaultModel ? { isDefault: true } : {}),
    });
  }
  return providerModelsFromSettings(models, settings.customModels, EMPTY_CAPABILITIES);
}

function fallbackModelsFor(settings: AgySettings): ReadonlyArray<ServerProviderModel> {
  return modelsFromDiscovered(
    [{ slug: settings.defaultModel, name: settings.defaultModel }],
    settings,
  );
}

const runAgy = (
  settings: AgySettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const command = settings.binaryPath || "agy";
    const resolved = yield* resolveSpawnCommand(command, args, { env: environment });
    // Agy's `models` command keeps running when its stdout is an ordinary
    // Node pipe, while it exits normally under a PTY. Settings health checks
    // run from Node, so give this discovery-only probe a Linux pseudo-terminal.
    if (platform === "linux" && args.length === 1 && args[0] === "models") {
      const scriptCommand = [resolved.command, ...resolved.args]
        .map(quotePosixShellArgument)
        .join(" ");
      return yield* spawnAndCollect(
        command,
        ChildProcess.make("script", ["-q", "-e", "-c", scriptCommand, "/dev/null"], {
          env: environment,
        }),
      );
    }
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(resolved.command, resolved.args, {
        env: environment,
        shell: resolved.shell,
      }),
    );
  });

export const buildInitialAgyProviderSnapshot = Effect.fn("buildInitialAgyProviderSnapshot")(
  function* (settings: AgySettings): Effect.fn.Return<ServerProviderDraft> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: fallbackModelsFor(settings),
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Agy CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Agy is disabled in d4research settings.",
          },
    });
  },
);

export const checkAgyProviderStatus = Effect.fn("checkAgyProviderStatus")(function* (
  settings: AgySettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  import("effect/unstable/process").ChildProcessSpawner.ChildProcessSpawner
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = fallbackModelsFor(settings);
  if (!settings.enabled) return yield* buildInitialAgyProviderSnapshot(settings);

  const probe = yield* runAgy(settings, ["models"], environment).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(probe)) {
    const missing = isCommandMissingCause(probe.failure);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "Agy CLI (`agy`) is not installed or not on PATH."
          : "Failed to execute the Agy CLI health check.",
      },
    });
  }
  if (Option.isNone(probe.success)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Agy CLI health check timed out.",
      },
    });
  }

  const models = probe.success.value;
  const discovered = models.code === 0 ? parseAgyModelsOutput(models.stdout) : [];
  const healthy = models.code === 0 && discovered.length > 0;
  const versionProbe = healthy
    ? yield* runAgy(settings, ["--version"], environment).pipe(
        Effect.timeoutOption(PROBE_TIMEOUT_MS),
        Effect.result,
      )
    : null;
  const version =
    versionProbe && Result.isSuccess(versionProbe) && Option.isSome(versionProbe.success)
      ? parseGenericCliVersion(
          `${versionProbe.success.value.stdout}\n${versionProbe.success.value.stderr}`,
        )
      : null;
  // `script` forwards a PTY's combined output through stdout, including
  // diagnostics that a normal pipe would receive on stderr.
  const failureDetail = (models.stderr.trim() || models.stdout.trim()).slice(0, 500);
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models: healthy ? modelsFromDiscovered(discovered, settings) : fallbackModels,
    probe: {
      installed: true,
      version,
      status: healthy ? "ready" : "error",
      auth: healthy ? { status: "authenticated", type: "Agy account" } : { status: "unknown" },
      ...(!healthy
        ? {
            message: failureDetail
              ? `Agy model discovery failed: ${failureDetail}`
              : `Agy model discovery exited with code ${models.code}. Run \`agy models\` to diagnose authentication or connector settings.`,
          }
        : {}),
    },
  });
});
