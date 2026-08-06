/**
 * skillsInventory — unified discovery of agent skills across every root the
 * local agents read from, powering the /settings/skills page.
 *
 * Roots scanned:
 * - `<home>/.claude/skills` (recursive, category subdirectories) — Claude
 * - `<home>/.codex/skills` plus its `.system` subtree — Codex
 * - `<home>/.junie/skills` and `<home>/.junie/commands/*.md` — Junie
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

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { collectSkillDirectories, parseSkillFrontmatter } from "./provider/Drivers/ClaudeSkills.ts";

export type SkillsInventoryRoot = "claude-user" | "codex-user" | "junie-user" | "project";

export type SkillsInventoryAgent = "claude" | "codex" | "junie" | "all";

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
    codexUserSkills: `${homeDir}/.codex/skills`,
    codexSystemSkills: `${homeDir}/.codex/skills/.system`,
    junieUserSkills: `${homeDir}/.junie/skills`,
    junieUserCommands: `${homeDir}/.junie/commands`,
    ...(options.cwd
      ? {
          projectAgentsSkills: `${options.cwd}/.agents/skills`,
          projectClaudeSkills: `${options.cwd}/.claude/skills`,
        }
      : {}),
  } as const;
}

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

  for (const skill of yield* scanSkillsRoot(roots.claudeUserSkills)) {
    entries.push(toEntry(skill, "claude-user", "user", ["claude"]));
  }

  // `.system` is hidden, so the recursive scan of the codex root skips it and
  // it needs its own scan with the "system" scope.
  for (const skill of yield* scanSkillsRoot(roots.codexUserSkills)) {
    entries.push(toEntry(skill, "codex-user", "user", ["codex"]));
  }
  for (const skill of yield* scanSkillsRoot(roots.codexSystemSkills)) {
    entries.push(toEntry(skill, "codex-user", "system", ["codex"]));
  }

  for (const skill of yield* scanSkillsRoot(roots.junieUserSkills)) {
    entries.push(toEntry(skill, "junie-user", "user", ["junie"]));
  }
  entries.push(...(yield* scanJunieCommands(roots.junieUserCommands)));

  if (roots.projectAgentsSkills && roots.projectClaudeSkills) {
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
    for (const skill of yield* scanSkillsRoot(roots.projectAgentsSkills)) {
      mergeProject(skill, "all", false);
    }
    for (const skill of yield* scanSkillsRoot(roots.projectClaudeSkills)) {
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

export type ShareSkillTargetRoot = "claude-user" | "codex-user" | "junie-user" | "project";

export type ShareSkillResult =
  | { readonly ok: true; readonly targetPath: string; readonly mode: "symlink" | "copy" }
  | { readonly ok: false; readonly status: 400 | 409 | 500; readonly message: string };

const SHARE_TARGET_ROOTS: ReadonlySet<ShareSkillTargetRoot> = new Set<ShareSkillTargetRoot>([
  "claude-user",
  "codex-user",
  "junie-user",
  "project",
]);

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
export const shareSkill = Effect.fn("shareSkill")(function* (
  input: { readonly sourcePath: string; readonly targetRoot: ShareSkillTargetRoot },
  options: SkillsInventoryOptions = {},
): Effect.fn.Return<ShareSkillResult, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots = resolveSkillsRoots(options);

  const knownRoots: ReadonlyArray<string> = [
    roots.claudeUserSkills,
    roots.codexUserSkills,
    roots.junieUserSkills,
    roots.junieUserCommands,
    ...(roots.projectAgentsSkills ? [roots.projectAgentsSkills] : []),
    ...(roots.projectClaudeSkills ? [roots.projectClaudeSkills] : []),
  ];

  // Normalize a SKILL.md path to its containing skill directory.
  const resolvedInput = path.resolve(input.sourcePath);
  const sourceDirectory =
    path.basename(resolvedInput) === "SKILL.md" ? path.dirname(resolvedInput) : resolvedInput;

  // Traversal guard: the *lexically resolved* source must sit inside a known
  // root before any filesystem access happens.
  if (!knownRoots.some((root) => isInsideRoot(path, root, sourceDirectory))) {
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

  const targetPath = path.join(targetRootDirectory, path.basename(sourceReal));
  if (path.resolve(targetPath) === sourceReal || targetPath === sourceDirectory) {
    return { ok: false, status: 400, message: "Skill already lives in that root." };
  }

  const targetExists = yield* fileSystem.exists(targetPath).pipe(Effect.orElseSucceed(() => true));
  if (targetExists) {
    return {
      ok: false,
      status: 409,
      message: "A skill with that name already exists in the target root.",
    };
  }

  yield* fileSystem
    .makeDirectory(targetRootDirectory, { recursive: true })
    .pipe(Effect.orElseSucceed(() => undefined));

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
