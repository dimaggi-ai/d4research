// @effect-diagnostics nodeBuiltinImport:off
/**
 * skillsInventory — unified discovery of agent skills across every root the
 * local agents read from, powering the /settings/skills page.
 *
 * Roots scanned:
 * - `<home>/.claude/skills` (recursive, category subdirectories) — Claude
 * - `<home>/.agents/skills` — the shared Agent Skills root read by Codex,
 *   Cursor, Grok, and OpenCode
 * - `<home>/.codex/skills/.system` — Codex's bundled system skills
 * - `<home>/.junie/skills` and `<home>/.junie/commands/*.md` — Junie
 * - `<home>/.gemini/config/skills.json` — Agy registration for the shared
 *   `<home>/.agents/skills` root
 * - `<cwd>/.agents/skills` and `<cwd>/.claude/skills` — project scope; the
 *   two commonly alias each other via a symlink, so entries are deduplicated
 *   by realpath while the symlink relationship is still reported.
 *
 * The share operation makes a skill visible to another agent root by
 * symlinking it there (falling back to a recursive copy when symlinks are
 * unavailable), refusing traversal outside known roots and never overwriting
 * an existing target.
 *
 * @module skillsInventory
 */
import * as NodeOS from "node:os";
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { ServerProvider, ServerProviderSkill } from "@d4research/contracts";

import { collectSkillDirectories, parseSkillFrontmatter } from "./provider/Drivers/ClaudeSkills.ts";
import { writeFileStringAtomically } from "./atomicWrite.ts";

export type SkillsInventoryRoot =
  | "claude-user"
  | "codex-user"
  | "junie-user"
  | "agy-user"
  | "project";

export type SkillsInventoryAgent =
  | "claude"
  | "codex"
  | "cursor"
  | "grok"
  | "opencode"
  | "junie"
  | "agy"
  | "all";

export type SkillsInventoryScope = "user" | "project" | "system";

export interface SkillsInventoryEntry {
  readonly name: string;
  readonly description?: string;
  /** SKILL.md path for skills, the markdown file path for commands. */
  readonly path: string;
  readonly root: SkillsInventoryRoot;
  readonly kind: "skill" | "command";
  readonly scope: SkillsInventoryScope;
  /** Which agents can see this entry, based on the roots that alias it. */
  readonly agents: ReadonlyArray<SkillsInventoryAgent>;
  /** True when at least one root reaches this entry through a symlink. */
  readonly isSymlinked: boolean;
}

export interface SkillsInventoryOptions {
  /** Workspace to scan for project-scoped skills. */
  readonly cwd?: string | undefined;
  /** Home directory override for tests; defaults to `os.homedir()`. */
  readonly homeDir?: string | undefined;
}

export interface PortableSkillsInventoryLayerOptions extends SkillsInventoryOptions {
  /** Controlled scan boundary used by concurrency tests. */
  readonly scanInventory?: (() => Effect.Effect<ReadonlyArray<SkillsInventoryEntry>>) | undefined;
}

export class PortableSkillsInventory extends Context.Service<
  PortableSkillsInventory,
  {
    /** Cached environment-global inventory used to enrich provider snapshots. */
    readonly get: Effect.Effect<ReadonlyArray<SkillsInventoryEntry>>;
    /** Rescan after a successful install/share and notify every connected client. */
    readonly refresh: Effect.Effect<ReadonlyArray<SkillsInventoryEntry>>;
    readonly changes: Stream.Stream<ReadonlyArray<SkillsInventoryEntry>>;
  }
>()("d4research/skillsInventory/PortableSkillsInventory") {}

/**
 * Put the environment's portable user skills on every provider snapshot.
 * Clients then receive one truthful environment-scoped catalog even when a
 * CLI (Agy, Cursor, Grok, OpenCode) has no native skill-discovery API.
 */
export function mergePortableSkillsIntoProviders(
  providers: ReadonlyArray<ServerProvider>,
  inventory: ReadonlyArray<SkillsInventoryEntry>,
): ReadonlyArray<ServerProvider> {
  const portable = inventory
    .filter((entry) => entry.kind === "skill" && entry.scope === "user")
    .map(
      (entry): ServerProviderSkill => ({
        name: entry.name,
        path: entry.path,
        enabled: true,
        scope: entry.scope,
        ...(entry.description ? { description: entry.description } : {}),
      }),
    );
  return providers.map((provider) => {
    const byName = new Map(provider.skills.map((skill) => [skill.name, skill]));
    for (const skill of portable) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
    return { ...provider, skills: [...byName.values()] };
  });
}

const FIRST_HEADING_PATTERN = /^#{1,6}\s+(.+?)\s*$/m;

interface ScannedSkill {
  readonly name: string;
  readonly description?: string;
  readonly nominalPath: string;
  readonly realDirectory: string;
  readonly isSymlinked: boolean;
}

/**
 * Read one skill directory's SKILL.md and derive its name/description with
 * the same rules Claude Code applies: frontmatter name wins, the directory
 * name is the fallback, malformed frontmatter disqualifies the skill.
 */
const readSkillDirectory = Effect.fn("readSkillDirectory")(function* (
  skillDirectory: string,
): Effect.fn.Return<ScannedSkill | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skillPath = path.join(skillDirectory, "SKILL.md");
  const contents = yield* fileSystem
    .readFileString(skillPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (contents === undefined) {
    return undefined;
  }
  const frontmatter = parseSkillFrontmatter(contents);
  if (frontmatter.kind === "malformed") {
    return undefined;
  }
  const name =
    (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ??
    path.basename(skillDirectory).trim();
  if (!name) {
    return undefined;
  }
  const realDirectory = yield* fileSystem
    .realPath(skillDirectory)
    .pipe(Effect.orElseSucceed(() => skillDirectory));
  return {
    name,
    nominalPath: skillPath,
    realDirectory,
    isSymlinked: realDirectory !== skillDirectory,
    ...(frontmatter.kind === "parsed" && frontmatter.description
      ? { description: frontmatter.description }
      : {}),
  };
});

/** Scan one skills root recursively and read every discovered skill. */
const scanSkillsRoot = Effect.fn("scanSkillsRoot")(function* (
  rootDirectory: string,
): Effect.fn.Return<ReadonlyArray<ScannedSkill>, never, FileSystem.FileSystem | Path.Path> {
  const skillDirectories = yield* collectSkillDirectories(rootDirectory);
  const scanned: Array<ScannedSkill> = [];
  for (const skillDirectory of skillDirectories) {
    const skill = yield* readSkillDirectory(skillDirectory);
    if (skill) {
      scanned.push(skill);
    }
  }
  return scanned;
});

/**
 * Scan `<home>/.junie/commands/*.md` — one command per markdown file, with
 * the description taken from frontmatter or the first heading.
 */
const scanJunieCommands = Effect.fn("scanJunieCommands")(function* (
  commandsDirectory: string,
): Effect.fn.Return<ReadonlyArray<SkillsInventoryEntry>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem
    .readDirectory(commandsDirectory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  const commands: Array<SkillsInventoryEntry> = [];
  for (const entry of [...entries].sort()) {
    if (!entry.endsWith(".md") || entry.startsWith(".")) {
      continue;
    }
    const commandPath = path.join(commandsDirectory, entry);
    const contents = yield* fileSystem
      .readFileString(commandPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) {
      continue;
    }
    const frontmatter = parseSkillFrontmatter(contents);
    if (frontmatter.kind === "malformed") {
      continue;
    }
    const name =
      (frontmatter.kind === "parsed" ? frontmatter.name : undefined) ?? entry.replace(/\.md$/, "");
    const frontmatterDescription =
      frontmatter.kind === "parsed" ? frontmatter.description : undefined;
    const headingMatch = FIRST_HEADING_PATTERN.exec(contents);
    const description = frontmatterDescription ?? headingMatch?.[1]?.trim();
    commands.push({
      name,
      path: commandPath,
      root: "junie-user",
      kind: "command",
      scope: "user",
      agents: ["junie"],
      isSymlinked: false,
      ...(description ? { description } : {}),
    });
  }
  return commands;
});

function toEntry(
  skill: ScannedSkill,
  root: SkillsInventoryRoot,
  scope: SkillsInventoryScope,
  agents: ReadonlyArray<SkillsInventoryAgent>,
): SkillsInventoryEntry {
  return {
    name: skill.name,
    path: skill.nominalPath,
    root,
    kind: "skill",
    scope,
    agents,
    isSymlinked: skill.isSymlinked,
    ...(skill.description ? { description: skill.description } : {}),
  };
}

/** Resolve the known root directories for a home dir + workspace pair. */
export function resolveSkillsRoots(options: SkillsInventoryOptions = {}) {
  const homeDir = options.homeDir ?? NodeOS.homedir();
  return {
    homeDir,
    claudeUserSkills: `${homeDir}/.claude/skills`,
    // Keep the public `codex-user` root id for API compatibility, but point it
    // at the vendor-neutral Agent Skills root Codex actually reads. Cursor,
    // Grok, and OpenCode read this root natively too.
    codexUserSkills: `${homeDir}/.agents/skills`,
    // Older d4 builds incorrectly installed user skills here. It remains a
    // reconciliation source so existing installs migrate automatically, but
    // it is not reported as a live Codex user root.
    codexLegacyUserSkills: `${homeDir}/.codex/skills`,
    codexSystemSkills: `${homeDir}/.codex/skills/.system`,
    junieUserSkills: `${homeDir}/.junie/skills`,
    junieUserCommands: `${homeDir}/.junie/commands`,
    // Agy's installed customization docs define ~/.gemini/config/skills.json
    // as the global registry. The old antigravity-cli path is migration-only.
    agyConfigDirectory: `${homeDir}/.gemini/config`,
    agySkillsConfig: `${homeDir}/.gemini/config/skills.json`,
    agyLegacyUserSkills: `${homeDir}/.gemini/antigravity-cli/skills`,
    ...(options.cwd
      ? {
          projectAgentsSkills: `${options.cwd}/.agents/skills`,
          projectClaudeSkills: `${options.cwd}/.claude/skills`,
        }
      : {}),
  } as const;
}

function isInsideOrEqualRoot(path: Path.Path, root: string, candidate: string): boolean {
  return candidate === root || isInsideRoot(path, root, candidate);
}

const resolveTrustedExistingRoot = Effect.fn("resolveTrustedExistingSkillRoot")(function* (
  root: string,
  boundary: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const [boundaryReal, rootReal] = yield* Effect.all([
    fileSystem.realPath(boundary).pipe(Effect.orElseSucceed(() => undefined)),
    fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => undefined)),
  ]);
  if (boundaryReal === undefined || rootReal === undefined) return undefined;
  return isInsideOrEqualRoot(path, boundaryReal, rootReal) ? rootReal : undefined;
});

const prepareTrustedRoot = Effect.fn("prepareTrustedSkillRoot")(function* (
  root: string,
  boundary: string,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(boundary, { recursive: true }).pipe(Effect.ignore);
  const boundaryReal = yield* fileSystem
    .realPath(boundary)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (boundaryReal === undefined || !isInsideRoot(path, boundary, root)) return false;

  // Validate the nearest existing ancestor before mkdir follows a planted
  // symlink outside the configured home/workspace boundary.
  let ancestor = root;
  while (!(yield* fileSystem.exists(ancestor).pipe(Effect.orElseSucceed(() => false)))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
  const ancestorReal = yield* fileSystem
    .realPath(ancestor)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (ancestorReal === undefined || !isInsideOrEqualRoot(path, boundaryReal, ancestorReal)) {
    return false;
  }

  const created = yield* fileSystem.makeDirectory(root, { recursive: true }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!created) return false;
  return (yield* resolveTrustedExistingRoot(root, boundary)) !== undefined;
});

const AgySkillsConfigRecord = Schema.Record(Schema.String, Schema.Unknown);
const decodeAgySkillsConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AgySkillsConfigRecord),
);
const encodeAgySkillsConfig = Schema.encodeEffect(Schema.fromJsonString(AgySkillsConfigRecord));

const readAgySkillsConfig = Effect.fn("readAgySkillsConfig")(function* (
  configPath: string,
): Effect.fn.Return<Record<string, unknown> | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = yield* fileSystem.exists(configPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return {};
  const [directoryReal, configReal] = yield* Effect.all([
    fileSystem.realPath(path.dirname(configPath)).pipe(Effect.orElseSucceed(() => undefined)),
    fileSystem.realPath(configPath).pipe(Effect.orElseSucceed(() => undefined)),
  ]);
  if (
    directoryReal === undefined ||
    configReal === undefined ||
    !isInsideRoot(path, directoryReal, configReal)
  ) {
    return undefined;
  }
  const raw = yield* fileSystem
    .readFileString(configPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (raw === undefined) return undefined;
  return Option.getOrUndefined(yield* decodeAgySkillsConfig(raw).pipe(Effect.option));
});

function agyEntryPath(entry: unknown): string | undefined {
  return Predicate.isObject(entry) && "path" in entry && Predicate.isString(entry.path)
    ? entry.path
    : undefined;
}

function resolveAgyEntryPath(path: Path.Path, homeDir: string, entryPath: string): string {
  return entryPath.startsWith("~/")
    ? path.resolve(homeDir, entryPath.slice(2))
    : path.resolve(entryPath);
}

const isAgySharedRootRegistered = Effect.fn("isAgySharedRootRegistered")(function* (
  options: SkillsInventoryOptions = {},
): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const roots = resolveSkillsRoots(options);
  if ((yield* resolveTrustedExistingRoot(roots.agyConfigDirectory, roots.homeDir)) === undefined) {
    return false;
  }
  const config = yield* readAgySkillsConfig(roots.agySkillsConfig);
  if (config === undefined || !Array.isArray(config.entries)) return false;
  const canonical = path.resolve(roots.codexUserSkills);
  return config.entries.some((entry) => {
    const entryPath = agyEntryPath(entry);
    return (
      entryPath !== undefined && resolveAgyEntryPath(path, roots.homeDir, entryPath) === canonical
    );
  });
});

export type AgySkillsRegistrationResult =
  | { readonly ok: true; readonly changed: boolean; readonly configPath: string }
  | { readonly ok: false; readonly status: 500; readonly message: string };

/** Register the portable root through Agy's documented global config. */
export const ensureAgySkillsRegistration = Effect.fn("ensureAgySkillsRegistration")(function* (
  options: SkillsInventoryOptions = {},
): Effect.fn.Return<AgySkillsRegistrationResult, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const roots = resolveSkillsRoots(options);
  const prepared = yield* Effect.all([
    prepareTrustedRoot(roots.codexUserSkills, roots.homeDir),
    prepareTrustedRoot(roots.agyConfigDirectory, roots.homeDir),
  ]);
  if (prepared.some((ready) => !ready)) {
    return {
      ok: false,
      status: 500,
      message: "A configured user skills root escapes the home directory.",
    };
  }
  const config = yield* readAgySkillsConfig(roots.agySkillsConfig);
  if (config === undefined || (config.entries !== undefined && !Array.isArray(config.entries))) {
    return {
      ok: false,
      status: 500,
      message: "Agy skills.json is malformed; it was left untouched.",
    };
  }
  const entries = config.entries ?? [];
  const canonical = path.resolve(roots.codexUserSkills);
  const registered = entries.some((entry) => {
    const entryPath = agyEntryPath(entry);
    return (
      entryPath !== undefined && resolveAgyEntryPath(path, roots.homeDir, entryPath) === canonical
    );
  });
  if (registered) return { ok: true, changed: false, configPath: roots.agySkillsConfig };

  const encoded = yield* encodeAgySkillsConfig({
    ...config,
    entries: [...entries, { path: canonical }],
  }).pipe(Effect.option);
  if (Option.isNone(encoded)) {
    return { ok: false, status: 500, message: "Could not encode Agy skills.json." };
  }
  const written = yield* writeFileStringAtomically({
    filePath: roots.agySkillsConfig,
    contents: `${encoded.value}\n`,
  }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  return written
    ? { ok: true, changed: true, configPath: roots.agySkillsConfig }
    : { ok: false, status: 500, message: "Could not write Agy skills.json." };
});

/**
 * Build the unified skills inventory: every skill and command each local
 * agent can see, deduplicated by realpath where roots alias one another.
 * Sorted by name, then root, for a stable presentation order.
 */
export const readSkillsInventory = Effect.fn("readSkillsInventory")(function* (
  options: SkillsInventoryOptions = {},
): Effect.fn.Return<ReadonlyArray<SkillsInventoryEntry>, never, FileSystem.FileSystem | Path.Path> {
  const roots = resolveSkillsRoots(options);
  const entries: Array<SkillsInventoryEntry> = [];
  const scanTrusted = (root: string, boundary: string) =>
    resolveTrustedExistingRoot(root, boundary).pipe(
      Effect.flatMap((trusted) =>
        trusted === undefined ? Effect.succeed([]) : scanSkillsRoot(root),
      ),
    );

  for (const skill of yield* scanTrusted(roots.claudeUserSkills, roots.homeDir)) {
    entries.push(toEntry(skill, "claude-user", "user", ["claude"]));
  }

  // The shared root is native to these four CLIs. Claude and Junie receive
  // per-skill aliases during install/startup reconciliation. Agy joins this
  // list only when its documented global config registers the shared root.
  const agyRegistered = yield* isAgySharedRootRegistered(options);
  for (const skill of yield* scanTrusted(roots.codexUserSkills, roots.homeDir)) {
    entries.push(
      toEntry(skill, "codex-user", "user", [
        "codex",
        "cursor",
        "grok",
        "opencode",
        ...(agyRegistered ? (["agy"] as const) : []),
      ]),
    );
  }
  // `.system` remains under CODEX_HOME and is hidden from ordinary scans.
  for (const skill of yield* scanTrusted(roots.codexSystemSkills, roots.homeDir)) {
    entries.push(toEntry(skill, "codex-user", "system", ["codex"]));
  }

  for (const skill of yield* scanTrusted(roots.junieUserSkills, roots.homeDir)) {
    entries.push(toEntry(skill, "junie-user", "user", ["junie"]));
  }
  if ((yield* resolveTrustedExistingRoot(roots.junieUserCommands, roots.homeDir)) !== undefined) {
    entries.push(...(yield* scanJunieCommands(roots.junieUserCommands)));
  }

  if (roots.projectAgentsSkills && roots.projectClaudeSkills && options.cwd) {
    // The two project roots commonly alias each other (`.claude/skills` is a
    // symlink to `../.agents/skills`), so dedupe by resolved skill directory
    // while unioning the agents that can see each entry.
    const projectByRealPath = new Map<
      string,
      { skill: ScannedSkill; agents: Set<SkillsInventoryAgent>; symlinked: boolean }
    >();
    const mergeProject = (
      skill: ScannedSkill,
      agent: SkillsInventoryAgent,
      viaSymlinkedAlias: boolean,
    ) => {
      const existing = projectByRealPath.get(skill.realDirectory);
      if (existing) {
        existing.agents.add(agent);
        existing.symlinked = existing.symlinked || skill.isSymlinked || viaSymlinkedAlias;
        return;
      }
      projectByRealPath.set(skill.realDirectory, {
        skill,
        agents: new Set([agent]),
        symlinked: skill.isSymlinked || viaSymlinkedAlias,
      });
    };

    // `.agents/skills` is the shared root every agent reads; `.claude/skills`
    // is Claude-only unless it aliases the shared root.
    for (const skill of yield* scanTrusted(roots.projectAgentsSkills, options.cwd)) {
      mergeProject(skill, "all", false);
    }
    for (const skill of yield* scanTrusted(roots.projectClaudeSkills, options.cwd)) {
      mergeProject(skill, "claude", skill.isSymlinked);
    }

    for (const { skill, agents, symlinked } of projectByRealPath.values()) {
      const agentList: ReadonlyArray<SkillsInventoryAgent> = agents.has("all")
        ? ["all"]
        : [...agents].sort();
      entries.push({
        ...toEntry(skill, "project", "project", agentList),
        isSymlinked: symlinked,
      });
    }
  }

  return entries.sort(
    (left, right) => left.name.localeCompare(right.name) || left.root.localeCompare(right.root),
  );
});

/** One filesystem scan per mutation, shared by all websocket subscribers. */
export const makePortableSkillsInventoryLayer = (
  options: PortableSkillsInventoryLayerOptions = {},
) =>
  Layer.effect(
    PortableSkillsInventory,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const scan = () =>
        options.scanInventory !== undefined
          ? options.scanInventory()
          : readSkillsInventory(options).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
            );
      const initial = yield* scan();
      const current = yield* Ref.make(initial);
      const changes = yield* PubSub.unbounded<ReadonlyArray<SkillsInventoryEntry>>();
      const refreshSemaphore = yield* Semaphore.make(1);
      yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
      const refresh = refreshSemaphore.withPermits(1)(
        scan().pipe(
          Effect.tap((next) => Ref.set(current, next)),
          Effect.tap((next) => PubSub.publish(changes, next)),
        ),
      );
      return {
        get: Ref.get(current),
        refresh,
        get changes() {
          return Stream.fromPubSub(changes);
        },
      };
    }),
  );

export const PortableSkillsInventoryLive = makePortableSkillsInventoryLayer();

export type ShareSkillTargetRoot =
  | "claude-user"
  | "codex-user"
  | "junie-user"
  | "agy-user"
  | "project";

export type ShareSkillResult =
  | { readonly ok: true; readonly targetPath: string; readonly mode: "symlink" | "copy" | "config" }
  | { readonly ok: false; readonly status: 400 | 409 | 500; readonly message: string };

const SHARE_TARGET_ROOTS: ReadonlySet<ShareSkillTargetRoot> = new Set<ShareSkillTargetRoot>([
  "claude-user",
  "codex-user",
  "junie-user",
  "agy-user",
  "project",
]);

const PORTABLE_SKILL_DIRECTORY_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/u;
const skillMutationSemaphore = Semaphore.makeUnsafe(1);

export const withSkillMutationLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  skillMutationSemaphore.withPermits(1)(effect);

export function isShareSkillTargetRoot(value: unknown): value is ShareSkillTargetRoot {
  return typeof value === "string" && SHARE_TARGET_ROOTS.has(value as ShareSkillTargetRoot);
}

function isInsideRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Make a skill visible to another agent root by symlinking its directory
 * there, falling back to a recursive copy when the symlink fails (e.g. on a
 * filesystem without symlink support). The source must resolve inside a known
 * skills root — path traversal is rejected — and an existing target is never
 * overwritten.
 */
const shareSkillUnlocked = Effect.fn("shareSkillUnlocked")(function* (
  input: { readonly sourcePath: string; readonly targetRoot: ShareSkillTargetRoot },
  options: SkillsInventoryOptions = {},
): Effect.fn.Return<ShareSkillResult, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots = resolveSkillsRoots(options);

  const knownRoots: ReadonlyArray<{ readonly root: string; readonly boundary: string }> = [
    { root: roots.claudeUserSkills, boundary: roots.homeDir },
    { root: roots.codexUserSkills, boundary: roots.homeDir },
    { root: roots.codexLegacyUserSkills, boundary: roots.homeDir },
    { root: roots.junieUserSkills, boundary: roots.homeDir },
    { root: roots.junieUserCommands, boundary: roots.homeDir },
    { root: roots.agyLegacyUserSkills, boundary: roots.homeDir },
    ...(roots.projectAgentsSkills && options.cwd
      ? [{ root: roots.projectAgentsSkills, boundary: options.cwd }]
      : []),
    ...(roots.projectClaudeSkills && options.cwd
      ? [{ root: roots.projectClaudeSkills, boundary: options.cwd }]
      : []),
  ];

  // Normalize a SKILL.md path to its containing skill directory.
  const resolvedInput = path.resolve(input.sourcePath);
  const sourceDirectory =
    path.basename(resolvedInput) === "SKILL.md" ? path.dirname(resolvedInput) : resolvedInput;

  // Traversal guard: the *lexically resolved* source must sit inside a known
  // root before any filesystem access happens.
  const lexicalRoots = knownRoots.filter(({ root }) => isInsideRoot(path, root, sourceDirectory));
  if (lexicalRoots.length === 0) {
    return {
      ok: false,
      status: 400,
      message: "Source path is not inside a known skills root.",
    };
  }

  const sourceReal = yield* fileSystem
    .realPath(sourceDirectory)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (sourceReal === undefined) {
    return { ok: false, status: 400, message: "Source skill does not exist." };
  }

  // The lexical guard alone is spoofable: a symlink planted inside a skills
  // root can resolve anywhere — sharing it would symlink or recursively copy
  // that target (an ~/.ssh, say) into an agent root. The resolved path must
  // land inside a known root as well.
  const realRoots = yield* Effect.forEach(knownRoots, ({ root, boundary }) =>
    resolveTrustedExistingRoot(root, boundary),
  );
  if (!realRoots.some((root) => root !== undefined && isInsideRoot(path, root, sourceReal))) {
    return {
      ok: false,
      status: 400,
      message: "Source path resolves outside every known skills root.",
    };
  }

  const skillDirectoryName = path.basename(sourceDirectory);
  if (!PORTABLE_SKILL_DIRECTORY_NAME.test(skillDirectoryName) || skillDirectoryName === ".system") {
    return { ok: false, status: 400, message: "Skill directory name is not portable." };
  }

  if (input.targetRoot === "agy-user") {
    const canonicalPath = path.join(roots.codexUserSkills, skillDirectoryName);
    let createdCanonical = false;
    if (path.resolve(canonicalPath) !== path.resolve(sourceDirectory)) {
      const canonical = yield* shareSkillUnlocked(
        { sourcePath: sourceDirectory, targetRoot: "codex-user" },
        options,
      );
      if (!canonical.ok) return canonical;
      createdCanonical = true;
    }
    const registration = yield* ensureAgySkillsRegistration(options);
    if (!registration.ok) {
      if (createdCanonical) {
        yield* fileSystem
          .remove(canonicalPath, { recursive: true, force: true })
          .pipe(Effect.ignore);
      }
      return registration;
    }
    return { ok: true, targetPath: registration.configPath, mode: "config" };
  }

  const targetRootDirectory =
    input.targetRoot === "claude-user"
      ? roots.claudeUserSkills
      : input.targetRoot === "codex-user"
        ? roots.codexUserSkills
        : input.targetRoot === "junie-user"
          ? roots.junieUserSkills
          : roots.projectAgentsSkills;
  if (!targetRootDirectory) {
    return {
      ok: false,
      status: 400,
      message: "Project target root requires a workspace directory.",
    };
  }

  // Preserve the nominal skill id when the source itself is a symlink. Using
  // basename(sourceReal) here silently renamed aliases to their target folder.
  const targetPath = path.join(targetRootDirectory, skillDirectoryName);
  if (path.resolve(targetPath) === sourceReal || targetPath === sourceDirectory) {
    return { ok: false, status: 400, message: "Skill already lives in that root." };
  }

  const targetBoundary = input.targetRoot === "project" ? options.cwd : roots.homeDir;
  if (
    targetBoundary === undefined ||
    !(yield* prepareTrustedRoot(targetRootDirectory, targetBoundary))
  ) {
    return {
      ok: false,
      status: 400,
      message: "Target skills root escapes its configured boundary.",
    };
  }

  const targetExists = yield* fileSystem.exists(targetPath).pipe(Effect.orElseSucceed(() => true));
  if (targetExists) {
    return {
      ok: false,
      status: 409,
      message: "A skill with that name already exists in the target root.",
    };
  }

  const symlinked = yield* fileSystem.symlink(sourceReal, targetPath).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (symlinked) {
    return { ok: true, targetPath, mode: "symlink" };
  }

  const copied = yield* fileSystem.copy(sourceReal, targetPath).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (copied) {
    return { ok: true, targetPath, mode: "copy" };
  }
  return { ok: false, status: 500, message: "Could not share the skill into the target root." };
});

export const shareSkill = Effect.fn("shareSkill")(function* (
  input: { readonly sourcePath: string; readonly targetRoot: ShareSkillTargetRoot },
  options: SkillsInventoryOptions = {},
) {
  return yield* withSkillMutationLock(shareSkillUnlocked(input, options));
});

/** Keep the filesystem mutation and its published inventory snapshot atomic. */
export const shareSkillAndRefreshInventory = Effect.fn("shareSkillAndRefreshInventory")(function* (
  input: { readonly sourcePath: string; readonly targetRoot: ShareSkillTargetRoot },
  options: SkillsInventoryOptions = {},
) {
  const inventory = yield* PortableSkillsInventory;
  return yield* withSkillMutationLock(
    Effect.gen(function* () {
      const result = yield* shareSkillUnlocked(input, options);
      if (result.ok) yield* inventory.refresh;
      return result;
    }),
  );
});

export type UserSkillReconciliationTarget =
  | "claude-user"
  | "codex-user"
  | "junie-user"
  | "agy-user";

export interface UserSkillReconciliationResult {
  readonly shared: ReadonlyArray<{
    readonly name: string;
    readonly targetRoot: UserSkillReconciliationTarget;
    readonly mode: "symlink" | "copy" | "config";
  }>;
  readonly conflicts: ReadonlyArray<{
    readonly name: string;
    readonly targetRoot: UserSkillReconciliationTarget;
    readonly targetPath: string;
  }>;
  readonly failures: ReadonlyArray<{
    readonly name: string;
    readonly targetRoot: UserSkillReconciliationTarget;
    readonly message: string;
  }>;
}

/**
 * Reconcile user skills without prompting or overwriting anything.
 *
 * `~/.agents/skills` is canonical because Codex, Cursor, Grok, and OpenCode
 * read it natively. Skills found only in Claude, Junie, or d4's obsolete
 * `~/.codex/skills` location are first linked into the canonical root, then
 * missing Claude and Junie aliases are created from there. Agy receives the
 * canonical root through its documented global skills.json registry. Existing
 * divergent skills are reported as conflicts and left untouched.
 */
export const reconcileUserSkills = Effect.fn("reconcileUserSkills")(function* (
  options: SkillsInventoryOptions = {},
): Effect.fn.Return<UserSkillReconciliationResult, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots = resolveSkillsRoots(options);
  const shared: Array<UserSkillReconciliationResult["shared"][number]> = [];
  const conflicts: Array<UserSkillReconciliationResult["conflicts"][number]> = [];
  const failures: Array<UserSkillReconciliationResult["failures"][number]> = [];

  // Priority is intentional: the shared root is authoritative, then Claude
  // (historically d4's install root), then the obsolete Codex path, then Junie.
  const candidates = new Map<string, string>();
  for (const sourceRoot of [
    roots.codexUserSkills,
    roots.claudeUserSkills,
    roots.codexLegacyUserSkills,
    roots.junieUserSkills,
    roots.agyLegacyUserSkills,
  ]) {
    if ((yield* resolveTrustedExistingRoot(sourceRoot, roots.homeDir)) === undefined) continue;
    for (const skill of yield* scanSkillsRoot(sourceRoot)) {
      const skillDirectory = path.dirname(skill.nominalPath);
      const name = path.basename(skillDirectory);
      if (PORTABLE_SKILL_DIRECTORY_NAME.test(name) && name !== ".system" && !candidates.has(name)) {
        candidates.set(name, skillDirectory);
      }
    }
  }

  const rootsForTarget = {
    "claude-user": roots.claudeUserSkills,
    "codex-user": roots.codexUserSkills,
    "junie-user": roots.junieUserSkills,
  } as const;

  const ensureShared = Effect.fn("ensureUserSkillShared")(function* (
    name: string,
    sourcePath: string,
    targetRoot: UserSkillReconciliationTarget,
  ) {
    if (targetRoot === "agy-user") {
      const registration = yield* ensureAgySkillsRegistration(options);
      if (!registration.ok) {
        failures.push({ name, targetRoot, message: registration.message });
        return undefined;
      }
      if (registration.changed) {
        shared.push({ name, targetRoot, mode: "config" });
      }
      return registration.configPath;
    }
    const targetPath = path.join(rootsForTarget[targetRoot], name);
    const targetExists = yield* fileSystem
      .exists(targetPath)
      .pipe(Effect.orElseSucceed(() => true));
    if (targetExists) {
      const [sourceReal, targetReal] = yield* Effect.all([
        fileSystem.realPath(sourcePath).pipe(Effect.orElseSucceed(() => undefined)),
        fileSystem.realPath(targetPath).pipe(Effect.orElseSucceed(() => undefined)),
      ]);
      if (sourceReal !== undefined && sourceReal === targetReal) return targetPath;
      conflicts.push({ name, targetRoot, targetPath });
      return undefined;
    }

    const result = yield* shareSkill({ sourcePath, targetRoot }, options);
    if (result.ok) {
      shared.push({ name, targetRoot, mode: result.mode });
      return result.targetPath;
    }
    failures.push({ name, targetRoot, message: result.message });
    return undefined;
  });

  for (const [name, discoveredSource] of [...candidates.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const canonicalPath = path.join(roots.codexUserSkills, name);
    const canonicalExists = yield* fileSystem
      .exists(canonicalPath)
      .pipe(Effect.orElseSucceed(() => true));
    const canonicalSource = canonicalExists
      ? canonicalPath
      : yield* ensureShared(name, discoveredSource, "codex-user");
    if (!canonicalSource) continue;

    yield* ensureShared(name, canonicalSource, "claude-user");
    yield* ensureShared(name, canonicalSource, "junie-user");
    yield* ensureShared(name, canonicalSource, "agy-user");
  }

  return { shared, conflicts, failures };
});

// ---------------------------------------------------------------------------
// Install from a git repository
// ---------------------------------------------------------------------------

/**
 * Agy also accepts whole plugins through `agy plugin install`. This is
 * separate from its portable skills registry because plugins may include
 * hooks, MCP servers, and other package features.
 */
export type AgyPluginInstallOutcome =
  | "installed"
  | "not-requested"
  | "not-a-plugin"
  | "agy-unavailable"
  | "failed";

export function agyPluginInstallDecision(
  requested: boolean,
  hasManifest: boolean,
): "install" | "not-requested" | "not-a-plugin" {
  if (!requested) return "not-requested";
  return hasManifest ? "install" : "not-a-plugin";
}

export type InstallSkillResult =
  | {
      readonly ok: true;
      /** Skill directory names written into the shared Agent Skills root. */
      readonly installed: ReadonlyArray<string>;
      /** Roots each skill was additionally shared into, so every agent sees it. */
      readonly sharedRoots: ReadonlyArray<ShareSkillTargetRoot>;
      /** What happened for Agy's optional whole-plugin installation channel. */
      readonly agyPlugin: AgyPluginInstallOutcome;
    }
  | { readonly ok: false; readonly status: 400 | 409 | 500; readonly message: string };

type InstallSkillsFanoutResult =
  | {
      readonly ok: true;
      readonly installed: ReadonlyArray<string>;
      readonly sharedRoots: ReadonlyArray<ShareSkillTargetRoot>;
    }
  | { readonly ok: false; readonly status: 400 | 409 | 500; readonly message: string };

/**
 * Accepts only https/ssh git remotes. A skill install clones a remote and
 * writes executable instructions every agent then loads, so anything that
 * could reach the local filesystem (a file: URL, a bare path) or a non-git
 * scheme is refused rather than normalized.
 */
export function normalizeSkillRepoUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 500) return null;
  // Git also accepts the scp-like SSH form: user@host:owner/repo(.git)
  if (/^[a-z0-9._-]+@[a-z0-9.-]+:[\w./-]+$/i.test(trimmed)) return trimmed;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return null;
  // A password is always a secret we refuse to persist into a clone. A
  // username is only a secret over https; for ssh the `git@` user is the
  // normal, expected form.
  if (parsed.password.length > 0) return null;
  if (parsed.protocol === "https:" && parsed.username.length > 0) return null;
  return parsed.toString();
}

/** Directory name a repo URL installs under, when the repo has no skills/ dir. */
export function skillNameFromRepoUrl(url: string): string {
  const withoutSuffix = url.replace(/\.git$/i, "").replace(/\/+$/, "");
  const last = withoutSuffix.split(/[/:]/).pop() ?? "";
  const cleaned = last.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "skill";
}

/** A directory is a skill when it directly contains SKILL.md. */
const isSkillDirectory = (fileSystem: FileSystem.FileSystem, path: Path.Path, dir: string) =>
  fileSystem.exists(path.join(dir, "SKILL.md")).pipe(Effect.orElseSucceed(() => false));

/**
 * Finds every skill directory in a cloned repo: the conventional `skills/*`
 * layout, else the repo root when it is itself a skill.
 */
export const findSkillDirectories = Effect.fn("findSkillDirectories")(function* (
  repoDir: string,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found: string[] = [];

  const skillsDir = path.join(repoDir, "skills");
  const entries = yield* fileSystem
    .readDirectory(skillsDir)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  for (const entry of [...entries].sort()) {
    if (entry.startsWith(".")) continue;
    const candidate = path.join(skillsDir, entry);
    if (yield* isSkillDirectory(fileSystem, path, candidate)) found.push(candidate);
  }
  if (found.length > 0) return found;

  return (yield* isSkillDirectory(fileSystem, path, repoDir)) ? [repoDir] : [];
});

const CLONE_TIMEOUT_MS = 120_000;

/** Shallow-clone a remote into `targetDir`. Never runs through a shell. */
const cloneRepository = (url: string, targetDir: string): Effect.Effect<boolean> =>
  Effect.promise(
    () =>
      new Promise<boolean>((resolve) => {
        // execFile (not exec): the URL is an argv entry, so shell
        // metacharacters in it can never be interpreted.
        NodeChildProcess.execFile(
          "git",
          ["clone", "--depth", "1", "--single-branch", "--no-tags", "--", url, targetDir],
          { timeout: CLONE_TIMEOUT_MS, windowsHide: true },
          (error) => resolve(!error),
        );
      }),
  );

/**
 * Agy reads a plugin manifest at the repo root. Detecting it keeps the install
 * honest: a repo with no manifest is reported as `not-a-plugin` rather than
 * silently "installed everywhere".
 */
export const hasAgyPluginManifest = Effect.fn("hasAgyPluginManifest")(function* (
  repoDir: string,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const manifest of ["plugin.json", "gemini-extension.json"]) {
    const exists = yield* fileSystem
      .exists(path.join(repoDir, manifest))
      .pipe(Effect.orElseSucceed(() => false));
    if (exists) return true;
  }
  return false;
});

const AGY_INSTALL_TIMEOUT_MS = 180_000;

/**
 * Runs `agy plugin install <url>`. Best-effort by design: agy may not be on
 * this machine, and a plugin failure must not undo a good skill install.
 */
const installAgyPlugin = (url: string): Effect.Effect<AgyPluginInstallOutcome> =>
  Effect.promise(
    () =>
      new Promise<AgyPluginInstallOutcome>((resolve) => {
        NodeChildProcess.execFile(
          "agy",
          ["plugin", "install", url],
          { timeout: AGY_INSTALL_TIMEOUT_MS, windowsHide: true },
          (error) => {
            if (!error) return resolve("installed");
            const code = (error as NodeJS.ErrnoException).code;
            resolve(code === "ENOENT" ? "agy-unavailable" : "failed");
          },
        );
      }),
  );

export interface SkillInstallRuntime {
  readonly cloneRepository: (url: string, targetDir: string) => Effect.Effect<boolean>;
  readonly installAgyPlugin: (url: string) => Effect.Effect<AgyPluginInstallOutcome>;
}

const defaultSkillInstallRuntime: SkillInstallRuntime = {
  cloneRepository,
  installAgyPlugin,
};

/**
 * Atomically fans every skill in a prepared repository into Claude, Codex,
 * Junie, and Agy's documented registry. All names and destinations are preflighted before the first
 * write; if any later copy/link fails, every path created by this transaction
 * is removed. Existing skills are never touched.
 *
 * Exported so tests can exercise the exact production install transaction
 * against a local repository without mocking git or the filesystem.
 */
const installSkillsFromRepositoryUnlocked = Effect.fn("installSkillsFromRepositoryUnlocked")(
  function* (
    input: { readonly repoDir: string; readonly sourceUrl: string; readonly cwd?: string },
    options: SkillsInventoryOptions = {},
  ): Effect.fn.Return<InstallSkillsFanoutResult, never, FileSystem.FileSystem | Path.Path> {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const roots = resolveSkillsRoots(options);
    const skillDirs = yield* findSkillDirectories(input.repoDir);
    if (skillDirs.length === 0) {
      return {
        ok: false,
        status: 400,
        message: "No skill found: expected skills/<name>/SKILL.md or SKILL.md at the repo root.",
      };
    }

    const repositoryRoot = path.resolve(input.repoDir);
    const skills = skillDirs.map((skillDir) => {
      const isRepositoryRoot = path.resolve(skillDir) === repositoryRoot;
      return {
        sourcePath: skillDir,
        name: isRepositoryRoot ? skillNameFromRepoUrl(input.sourceUrl) : path.basename(skillDir),
      };
    });
    if (new Set(skills.map((skill) => skill.name)).size !== skills.length) {
      return { ok: false, status: 400, message: "The repository contains duplicate skill names." };
    }
    if (
      skills.some(
        (skill) => !PORTABLE_SKILL_DIRECTORY_NAME.test(skill.name) || skill.name === ".system",
      )
    ) {
      return {
        ok: false,
        status: 400,
        message: "Skill directory names must be portable and may not be hidden or reserved.",
      };
    }

    const realRepoDir = yield* fileSystem
      .realPath(input.repoDir)
      .pipe(Effect.orElseSucceed(() => input.repoDir));
    for (const skill of skills) {
      const [realSkillDir, realManifest] = yield* Effect.all([
        fileSystem.realPath(skill.sourcePath).pipe(Effect.orElseSucceed(() => "")),
        fileSystem
          .realPath(path.join(skill.sourcePath, "SKILL.md"))
          .pipe(Effect.orElseSucceed(() => "")),
      ]);
      const staysInRepository = (candidate: string) =>
        candidate === realRepoDir || isInsideRoot(path, realRepoDir, candidate);
      if (!staysInRepository(realSkillDir) || !staysInRepository(realManifest)) {
        return {
          ok: false,
          status: 400,
          message: `Skill "${skill.name}" resolves outside the cloned repository.`,
        };
      }
    }

    const targetRoots = [
      ["codex-user", roots.codexUserSkills],
      ["claude-user", roots.claudeUserSkills],
      ["junie-user", roots.junieUserSkills],
    ] as const;
    const rootsCreated = yield* Effect.forEach(targetRoots, ([, rootDirectory]) =>
      prepareTrustedRoot(rootDirectory, roots.homeDir),
    );
    if (rootsCreated.some((created) => !created)) {
      return { ok: false, status: 500, message: "Could not prepare every agent skills root." };
    }
    for (const skill of skills) {
      for (const [, rootDirectory] of targetRoots) {
        const targetPath = path.join(rootDirectory, skill.name);
        const exists = yield* fileSystem.exists(targetPath).pipe(Effect.orElseSucceed(() => true));
        if (!exists) continue;
        return {
          ok: false,
          status: 409,
          message: `A skill named "${skill.name}" is already installed. Remove it first.`,
        };
      }
    }

    const transactionPaths: string[] = [];
    const rollback = () =>
      Effect.forEach(
        transactionPaths.toReversed(),
        (targetPath) =>
          fileSystem.remove(targetPath, { recursive: true, force: true }).pipe(Effect.ignore),
        { discard: true },
      );

    for (const skill of skills) {
      const sourcePath = path.join(roots.codexUserSkills, skill.name);
      transactionPaths.push(sourcePath);
      const copied = yield* fileSystem.copy(skill.sourcePath, sourcePath).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (!copied) {
        yield* rollback();
        return { ok: false, status: 500, message: `Could not write the skill "${skill.name}".` };
      }
      for (const targetRoot of ["claude-user", "junie-user"] as const) {
        const targetDirectory =
          targetRoot === "claude-user" ? roots.claudeUserSkills : roots.junieUserSkills;
        transactionPaths.push(path.join(targetDirectory, skill.name));
        const shared = yield* shareSkillUnlocked(
          { sourcePath, targetRoot },
          { ...options, ...(input.cwd ? { cwd: input.cwd } : {}) },
        );
        if (!shared.ok) {
          yield* rollback();
          return {
            ok: false,
            status: shared.status,
            message: `Could not share "${skill.name}" to ${targetRoot}: ${shared.message}`,
          };
        }
      }
    }

    const agyRegistration = yield* ensureAgySkillsRegistration(options);
    if (!agyRegistration.ok) {
      yield* rollback();
      return agyRegistration;
    }

    return {
      ok: true,
      installed: skills.map((skill) => skill.name),
      sharedRoots: ["claude-user", "junie-user", "agy-user"],
    };
  },
);

/** Serialize the preflight/write/rollback transaction across every HTTP caller. */
export const installSkillsFromRepository = Effect.fn("installSkillsFromRepository")(function* (
  input: { readonly repoDir: string; readonly sourceUrl: string; readonly cwd?: string },
  options: SkillsInventoryOptions = {},
) {
  return yield* withSkillMutationLock(installSkillsFromRepositoryUnlocked(input, options));
});

/** Clone and install every repository skill into every supported CLI root. */
export const installSkillFromGit = Effect.fn("installSkillFromGit")(function* (
  input: {
    readonly url: string;
    readonly cwd?: string;
    /**
     * Agy plugins may contain executable hooks and MCP servers. Keep that
     * broader package install behind a separate, explicit user opt-in.
     */
    readonly installAgyPlugin?: boolean;
  },
  options: SkillsInventoryOptions = {},
  runtime: SkillInstallRuntime = defaultSkillInstallRuntime,
): Effect.fn.Return<InstallSkillResult, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const url = normalizeSkillRepoUrl(input.url);
  if (url === null) {
    return { ok: false, status: 400, message: "Expected an https or ssh git URL." };
  }

  const lifecycle = Effect.scoped(
    Effect.gen(function* () {
      const scratch = yield* fileSystem.makeTempDirectoryScoped({ prefix: "d4-skill-install-" });
      const repoDir = path.join(scratch, "repo");
      const cloned = yield* runtime.cloneRepository(url, repoDir);
      if (!cloned) {
        return { ok: false, status: 400, message: "Could not clone that repository." } as const;
      }

      const fanout = yield* installSkillsFromRepositoryUnlocked(
        { repoDir, sourceUrl: url, ...(input.cwd ? { cwd: input.cwd } : {}) },
        options,
      );
      if (!fanout.ok) return fanout;

      // Portable skills are installed for Agy above. Installing the whole
      // plugin is a broader capability grant and must never happen merely
      // because a cloned repository happens to contain a manifest.
      const agyPluginDecision = agyPluginInstallDecision(
        input.installAgyPlugin === true,
        input.installAgyPlugin === true && (yield* hasAgyPluginManifest(repoDir)),
      );
      const agyPlugin =
        agyPluginDecision === "install" ? yield* runtime.installAgyPlugin(url) : agyPluginDecision;

      return { ...fanout, agyPlugin };
    }),
  );

  // Clone, filesystem fan-out, and an optional Agy mutation are one serialized
  // lifecycle. Locking only the copy phase still permits unbounded clones and
  // concurrent `agy plugin install` processes from authenticated callers.
  return yield* withSkillMutationLock(lifecycle).pipe(
    Effect.orElseSucceed(
      () =>
        ({
          ok: false,
          status: 500,
          message: "Could not create or clean up the temporary install directory.",
        }) as const,
    ),
  );
});
