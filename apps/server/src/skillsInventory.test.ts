import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readSkillsInventory, shareSkill } from "./skillsInventory.ts";

const writeSkill = Effect.fn(function* (skillDirectory: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(skillDirectory, { recursive: true });
  yield* fs.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
});

const frontmatter = (name: string, description?: string) =>
  ["---", `name: ${name}`, ...(description ? [`description: ${description}`] : []), "---"].join(
    "\n",
  );

it.layer(NodeServices.layer)("readSkillsInventory", (it) => {
  it.effect("merges every agent root, including nested categories and codex .system", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-inventory-" });
      const homeDir = path.join(tempDir, "home");

      // Claude keeps skills one category level deep in real setups.
      yield* writeSkill(
        path.join(homeDir, ".claude", "skills", "writing", "copywriting"),
        frontmatter("copywriting", "Write copy."),
      );
      yield* writeSkill(
        path.join(homeDir, ".codex", "skills", "local-helper"),
        frontmatter("local-helper"),
      );
      // `.system` is hidden, so it needs its own scan and carries the system scope.
      yield* writeSkill(
        path.join(homeDir, ".codex", "skills", ".system", "skill-creator"),
        frontmatter("skill-creator", "Create skills."),
      );
      yield* writeSkill(
        path.join(homeDir, ".junie", "skills", "security-review"),
        frontmatter("security-review"),
      );
      yield* fs.makeDirectory(path.join(homeDir, ".junie", "commands"), { recursive: true });
      yield* fs.writeFileString(
        path.join(homeDir, ".junie", "commands", "storyboard.md"),
        "# Generate a shot list\n\nBody.",
      );

      const entries = yield* readSkillsInventory({ homeDir });

      assert.deepEqual(
        entries.map((entry) => [entry.name, entry.root, entry.scope, entry.kind]),
        [
          ["copywriting", "claude-user", "user", "skill"],
          ["local-helper", "codex-user", "user", "skill"],
          ["security-review", "junie-user", "user", "skill"],
          ["skill-creator", "codex-user", "system", "skill"],
          ["storyboard", "junie-user", "user", "command"],
        ],
      );
      assert.equal(entries[0]?.description, "Write copy.");
      assert.deepEqual(entries[0]?.agents, ["claude"]);
      // A command with no frontmatter falls back to its first heading.
      assert.equal(entries[4]?.description, "Generate a shot list");
      assert.equal(
        entries[0]?.path,
        path.join(homeDir, ".claude", "skills", "writing", "copywriting", "SKILL.md"),
      );
    }),
  );

  it.effect("deduplicates project roots that alias each other through a symlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-inventory-" });
      const homeDir = path.join(tempDir, "home");
      const cwd = path.join(tempDir, "workspace");

      yield* writeSkill(
        path.join(cwd, ".agents", "skills", "update-docs"),
        frontmatter("update-docs"),
      );
      yield* fs.makeDirectory(path.join(cwd, ".claude"), { recursive: true });
      // The real repo layout: `.claude/skills` is a symlink to `../.agents/skills`.
      yield* fs.symlink(path.join(cwd, ".agents", "skills"), path.join(cwd, ".claude", "skills"));

      const entries = yield* readSkillsInventory({ homeDir, cwd });

      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.name, "update-docs");
      assert.equal(entries[0]?.root, "project");
      // Reached through both roots, so every agent sees it, and the aliasing is reported.
      assert.deepEqual(entries[0]?.agents, ["all"]);
      assert.equal(entries[0]?.isSymlinked, true);
    }),
  );

  it.effect("keeps a claude-only project skill distinct from the shared root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-inventory-" });
      const homeDir = path.join(tempDir, "home");
      const cwd = path.join(tempDir, "workspace");

      yield* writeSkill(path.join(cwd, ".agents", "skills", "shared"), frontmatter("shared"));
      yield* writeSkill(
        path.join(cwd, ".claude", "skills", "claude-only"),
        frontmatter("claude-only"),
      );

      const entries = yield* readSkillsInventory({ homeDir, cwd });

      assert.deepEqual(
        entries.map((entry) => [entry.name, entry.agents, entry.isSymlinked]),
        [
          ["claude-only", ["claude"], false],
          ["shared", ["all"], false],
        ],
      );
    }),
  );

  it.effect("skips malformed frontmatter and unreadable roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-inventory-" });
      const homeDir = path.join(tempDir, "home");

      yield* writeSkill(
        path.join(homeDir, ".claude", "skills", "broken"),
        ["---", "name: [unclosed", "---"].join("\n"),
      );
      yield* writeSkill(path.join(homeDir, ".claude", "skills", "fine"), frontmatter("fine"));

      const entries = yield* readSkillsInventory({ homeDir });

      assert.deepEqual(
        entries.map((entry) => entry.name),
        ["fine"],
      );
    }),
  );
});

it.layer(NodeServices.layer)("shareSkill", (it) => {
  it.effect("rejects a source path that escapes every known skills root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-share-" });
      const homeDir = path.join(tempDir, "home");
      yield* writeSkill(path.join(homeDir, ".claude", "skills", "keeper"), frontmatter("keeper"));

      const traversal = yield* shareSkill(
        {
          sourcePath: path.join(homeDir, ".claude", "skills", "..", "..", ".ssh"),
          targetRoot: "codex-user",
        },
        { homeDir },
      );
      assert.equal(traversal.ok, false);
      assert.equal(traversal.ok === false ? traversal.status : 0, 400);

      const outside = yield* shareSkill(
        { sourcePath: "/etc/passwd", targetRoot: "codex-user" },
        { homeDir },
      );
      assert.equal(outside.ok, false);
      assert.equal(outside.ok === false ? outside.status : 0, 400);

      // The rejected traversal must not have created anything in the target.
      const codexExists = yield* fs
        .exists(path.join(homeDir, ".codex", "skills"))
        .pipe(Effect.orElseSucceed(() => false));
      assert.equal(codexExists, false);
    }),
  );

  it.effect("symlinks a known skill into another agent root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-share-" });
      const homeDir = path.join(tempDir, "home");
      const source = path.join(homeDir, ".claude", "skills", "writing", "copywriting");
      yield* writeSkill(source, frontmatter("copywriting"));

      // A SKILL.md path is accepted and normalized to its skill directory.
      const result = yield* shareSkill(
        { sourcePath: path.join(source, "SKILL.md"), targetRoot: "codex-user" },
        { homeDir },
      );

      assert.equal(result.ok, true);
      assert.equal(result.ok === true ? result.mode : "", "symlink");
      const shared = path.join(homeDir, ".codex", "skills", "copywriting");
      assert.equal(result.ok === true ? result.targetPath : "", shared);
      const manifest = yield* fs.readFileString(path.join(shared, "SKILL.md"));
      assert.match(manifest, /name: copywriting/);

      // The shared skill is now visible to Codex in the inventory.
      const entries = yield* readSkillsInventory({ homeDir });
      assert.deepEqual(
        entries.map((entry) => [entry.name, entry.root]),
        [
          ["copywriting", "claude-user"],
          ["copywriting", "codex-user"],
        ],
      );
    }),
  );

  it.effect("refuses to overwrite an existing target and a no-op share", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-share-" });
      const homeDir = path.join(tempDir, "home");
      const source = path.join(homeDir, ".claude", "skills", "review");
      yield* writeSkill(source, frontmatter("review"));
      yield* writeSkill(
        path.join(homeDir, ".codex", "skills", "review"),
        frontmatter("review", "A different, pre-existing skill."),
      );

      const conflict = yield* shareSkill(
        { sourcePath: source, targetRoot: "codex-user" },
        { homeDir },
      );
      assert.equal(conflict.ok, false);
      assert.equal(conflict.ok === false ? conflict.status : 0, 409);
      // The pre-existing target is untouched.
      const manifest = yield* fs.readFileString(
        path.join(homeDir, ".codex", "skills", "review", "SKILL.md"),
      );
      assert.match(manifest, /A different, pre-existing skill\./);

      const selfShare = yield* shareSkill(
        { sourcePath: source, targetRoot: "claude-user" },
        { homeDir },
      );
      assert.equal(selfShare.ok, false);
    }),
  );

  it.effect("requires a workspace before sharing into the project root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-share-" });
      const homeDir = path.join(tempDir, "home");
      const source = path.join(homeDir, ".claude", "skills", "portable");
      yield* writeSkill(source, frontmatter("portable"));

      const withoutCwd = yield* shareSkill(
        { sourcePath: source, targetRoot: "project" },
        { homeDir },
      );
      assert.equal(withoutCwd.ok, false);
      assert.equal(withoutCwd.ok === false ? withoutCwd.status : 0, 400);

      const cwd = path.join(tempDir, "workspace");
      const withCwd = yield* shareSkill(
        { sourcePath: source, targetRoot: "project" },
        { homeDir, cwd },
      );
      assert.equal(withCwd.ok, true);
      assert.equal(
        withCwd.ok === true ? withCwd.targetPath : "",
        path.join(cwd, ".agents", "skills", "portable"),
      );
    }),
  );
});
