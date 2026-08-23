import type {
  ProviderDriverKind,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderUsage,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ServerProviderModel,
  ServerProviderState,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { normalizeCustomModelSlug } from "@d4research/shared/model";
import { isWindowsCommandNotFound } from "../processRunner.ts";
import { createProviderVersionAdvisory } from "./providerMaintenance.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

export const DEFAULT_TIMEOUT_MS = 4_000;
// Auth status checks involve disk/network lookups and can be slow on first run (especially Windows)
export const AUTH_PROBE_TIMEOUT_MS = 10_000;

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export class ProviderCommandNotFoundError extends Schema.TaggedErrorClass<ProviderCommandNotFoundError>()(
  "ProviderCommandNotFoundError",
  {
    binaryPath: Schema.String,
    exitCode: Schema.Number,
    stdoutLength: Schema.Number,
    stderrLength: Schema.Number,
  },
) {
  override get message(): string {
    return `Provider command ${this.binaryPath} was not found (exit code ${this.exitCode}).`;
  }
}

const isProviderCommandNotFoundError = Schema.is(ProviderCommandNotFoundError);

export interface ProviderProbeResult {
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

function providerReadiness(input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly probe: ProviderProbeResult;
}) {
  const installation = !input.enabled
    ? ("disabled" as const)
    : input.probe.installed
      ? ("ready" as const)
      : ("missing" as const);
  const authentication =
    input.probe.auth.status === "authenticated"
      ? ("ready" as const)
      : input.probe.auth.status === "unauthenticated"
        ? ("required" as const)
        : ("unknown" as const);
  const reachability =
    input.enabled && input.probe.installed && input.probe.status === "ready"
      ? ("ready" as const)
      : input.probe.status === "error"
        ? ("failed" as const)
        : ("unknown" as const);
  const modelCatalog =
    input.models.length === 0
      ? ("missing" as const)
      : reachability === "ready"
        ? ("ready" as const)
        : ("unknown" as const);
  const canStart =
    installation === "ready" &&
    authentication !== "required" &&
    reachability === "ready" &&
    modelCatalog === "ready";
  const remediation = canStart
    ? undefined
    : !input.enabled
      ? "Enable this provider in Settings → Providers."
      : !input.probe.installed
        ? (input.probe.message ?? "Install the provider CLI and refresh its status.")
        : authentication === "required"
          ? (input.probe.message ?? "Authenticate the provider CLI, then refresh its status.")
          : modelCatalog === "missing"
            ? "No usable models were discovered. Check the provider endpoint and credentials, then refresh."
            : (input.probe.message ?? "The provider probe did not confirm a usable connection.");
  return {
    installation,
    authentication,
    reachability,
    modelCatalog,
    canStart,
    checkedAt: input.checkedAt,
    ...(remediation ? { remediation } : {}),
  };
}

export interface ServerProviderPresentation {
  readonly displayName: string;
  readonly badgeLabel?: string;
  readonly showInteractionModeToggle?: boolean;
  readonly requiresNewThreadForModelChange?: boolean;
}

export type ServerProviderDraft = Omit<ServerProvider, "instanceId" | "driver">;

export function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isCommandMissingCause(error: unknown): boolean {
  if (isProviderCommandNotFoundError(error)) return true;
  return error instanceof PlatformError.PlatformError && error.reason._tag === "NotFound";
}

export const spawnAndCollect = (binaryPath: string, command: ChildProcess.Command) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    const result: CommandResult = { stdout, stderr, code: exitCode };
    if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
      return yield* new ProviderCommandNotFoundError({
        binaryPath,
        exitCode,
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      });
    }
    return result;
  }).pipe(Effect.scoped);

export function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

export function extractAuthBoolean(value: unknown): boolean | undefined {
  if (globalThis.Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function parseGenericCliVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

const BRAND_CASING: Record<string, string> = {
  glm: "GLM",
  gpt: "GPT",
  oss: "OSS",
  llm: "LLM",
  ai: "AI",
};

function humanizeModelSlug(slug: string): string {
  if (slug.includes("/")) return slug;
  const [base, tag] = slug.split(":", 2) as [string, string | undefined];
  const words = base.split(/[-_]+/u).map((w) => {
    if (/^\d/u.test(w)) return w;
    const lower = w.toLowerCase();
    return BRAND_CASING[lower] ?? w.charAt(0).toUpperCase() + w.slice(1);
  });
  const name = words.join(" ");
  return tag && tag !== "latest" ? `${name} (${tag})` : name;
}

export function providerModelsFromSettings(
  builtInModels: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<string>,
  customModelCapabilities: ModelCapabilities,
): ReadonlyArray<ServerProviderModel> {
  const resolvedBuiltInModels = [...builtInModels];
  const seen = new Set(resolvedBuiltInModels.map((model) => model.slug));
  const customEntries: ServerProviderModel[] = [];

  for (const candidate of customModels) {
    const normalized = normalizeCustomModelSlug(candidate);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    customEntries.push({
      slug: normalized,
      name: humanizeModelSlug(normalized),
      isCustom: true,
      capabilities: customModelCapabilities,
    });
  }

  return [...resolvedBuiltInModels, ...customEntries];
}

export function buildSelectOptionDescriptor(input: {
  readonly id: string;
  readonly label: string;
  readonly options:
    | ReadonlyArray<{ value: string; label: string; isDefault?: boolean | undefined }>
    | undefined;
  readonly description?: string;
  readonly promptInjectedValues?: ReadonlyArray<string>;
}) {
  const options = (input.options ?? []).map((option) =>
    option.isDefault
      ? { id: option.value, label: option.label, isDefault: true }
      : { id: option.value, label: option.label },
  );
  const currentValue = options.find((option) => option.isDefault)?.id;
  return {
    id: input.id,
    label: input.label,
    type: "select" as const,
    options,
    ...(currentValue ? { currentValue } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.promptInjectedValues && input.promptInjectedValues.length > 0
      ? { promptInjectedValues: [...input.promptInjectedValues] }
      : {}),
  };
}

export function buildBooleanOptionDescriptor(input: {
  readonly id: string;
  readonly label: string;
  readonly currentValue?: boolean;
  readonly description?: string;
}) {
  return {
    id: input.id,
    label: input.label,
    type: "boolean" as const,
    ...(input.description ? { description: input.description } : {}),
    ...(typeof input.currentValue === "boolean" ? { currentValue: input.currentValue } : {}),
  };
}

export function buildServerProvider(input: {
  driver?: ProviderDriverKind;
  presentation: ServerProviderPresentation;
  enabled: boolean;
  checkedAt: string;
  models: ReadonlyArray<ServerProviderModel>;
  slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
  skills?: ReadonlyArray<ServerProviderSkill>;
  usage?: ServerProviderUsage;
  probe: ProviderProbeResult;
}): ServerProviderDraft {
  const versionAdvisory = input.driver
    ? createProviderVersionAdvisory({
        driver: input.driver,
        currentVersion: input.probe.version,
        checkedAt: input.checkedAt,
      })
    : undefined;
  return {
    displayName: input.presentation.displayName,
    ...(input.presentation.badgeLabel ? { badgeLabel: input.presentation.badgeLabel } : {}),
    ...(typeof input.presentation.showInteractionModeToggle === "boolean"
      ? { showInteractionModeToggle: input.presentation.showInteractionModeToggle }
      : {}),
    ...(typeof input.presentation.requiresNewThreadForModelChange === "boolean"
      ? { requiresNewThreadForModelChange: input.presentation.requiresNewThreadForModelChange }
      : {}),
    enabled: input.enabled,
    installed: input.probe.installed,
    version: input.probe.version,
    status: input.enabled ? input.probe.status : "disabled",
    auth: input.probe.auth,
    checkedAt: input.checkedAt,
    ...(input.probe.message ? { message: input.probe.message } : {}),
    models: input.models,
    slashCommands: [...(input.slashCommands ?? [])],
    skills: [...(input.skills ?? [])],
    ...(versionAdvisory ? { versionAdvisory } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
    readiness: providerReadiness(input),
  };
}

export const collectStreamAsString = <E>(
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, E> =>
  collectUint8StreamText({ stream }).pipe(Effect.map((collected) => collected.text));
