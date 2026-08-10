import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  agyPluginInstallDecision,
  ensureAgySkillsRegistration,
  findSkillDirectories,
  hasAgyPluginManifest,
  installSkillFromGit,
  installSkillsFromRepository,
  makePortableSkillsInventoryLayer,
  mergePortableSkillsIntoProviders,
  normalizeSkillRepoUrl,
  readSkillsInventory,
  PortableSkillsInventory,
  reconcileUserSkills,
  shareSkill,
  shareSkillAndRefreshInventory,
  skillNameFromRepoUrl,
} from "./skillsInventory.ts";
import type { ServerProvider } from "@t3tools/contracts";

it("never installs a whole Agy plugin without explicit opt-in", () => {
  // A manifest alone is not consent: this is the regression boundary for
  // repositories that bundle executable hooks or MCP servers with a skill.
  assert.equal(agyPluginInstallDecision(false, true), "not-requested");
  assert.equal(agyPluginInstallDecision(false, false), "not-requested");
  assert.equal(agyPluginInstallDecision(true, false), "not-a-plugin");
  assert.equal(agyPluginInstallDecision(true, true), "install");
});

it("adds the same portable catalog to providers without native skill discovery", () => {
  const providers = ["claudeAgent", "codex", "cursor", "grok", "opencode", "junie", "agy"].map(
    (instanceId) =>
      ({
        instanceId,
        skills:
          instanceId === "claudeAgent"
            ? [{ name: "native", path: "/native/SKILL.md", enabled: true, scope: "user" }]
            : [],
      }) as unknown as ServerProvider,
  );
  const merged = mergePortableSkillsIntoProviders(providers, [
    {
      name: "shared",
      path: "/remote/.agents/skills/shared/SKILL.md",
      root: "codex-user",
      kind: "skill",
      scope: "user",
      agents: ["all"],
      isSymlinked: false,
    },
    {
      name: "system-only",
      path: "/remote/.codex/skills/.system/internal/SKILL.md",
      root: "codex-user",
      kind: "skill",
      scope: "system",
      agents: ["codex"],
      isSymlinked: false,
    },
  ]);

  assert.lengthOf(merged, 7);
  for (const provider of merged) {
    assert.include(
      provider.skills.map((skill) => skill.name),
      "shared",
    );
    assert.notInclude(
      provider.skills.map((skill) => skill.name),
      "system-only",
    );
  }
  assert.deepEqual(
    merged[0]?.skills.map((skill) => skill.name),
    ["native", "shared"],
  );
});

it.effect("publishes an installed skill to an already-open inventory subscription", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-portable-skills-stream-" });
    const homeDir = path.join(tempDir, "home");

    yield* Effect.gen(function* () {
      const inventory = yield* PortableSkillsInventory;
      const nextSnapshotFiber = yield* Stream.runHead(inventory.changes).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* writeSkill(
        path.join(homeDir, ".agents", "skills", "new-review"),
        frontmatter("new-review", "appears without a provider refresh"),
      );
      yield* inventory.refresh;

      const published = yield* Fiber.join(nextSnapshotFiber);
      assert.deepEqual(
        published.pipe(
          Option.map((entries) => entries.map((entry) => entry.name)),
          Option.getOrElse(() => []),
        ),
        ["new-review"],
      );
      assert.deepEqual(
        (yield* inventory.get).map((entry) => entry.name),
        ["new-review"],
      );
    }).pipe(Effect.provide(makePortableSkillsInventoryLayer({ homeDir })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("serializes refresh scans so an older snapshot cannot publish after a newer one", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const calls = yield* Ref.make(0);
    const entry = (name: string) => [
      {
        name,
        path: `/skills/${name}/SKILL.md`,
        root: "codex-user" as const,
        kind: "skill" as const,
        scope: "user" as const,
        agents: ["all" as const],
        isSymlinked: false,
      },
    ];
    const scanInventory = () =>
      Effect.gen(function* () {
        const call = yield* Ref.updateAndGet(calls, (count) => count + 1);
        if (call === 1) return [];
        if (call === 2) {
          yield* Deferred.succeed(firstStarted, undefined);
          yield* Deferred.await(releaseFirst);
          return entry("older");
        }
        yield* Deferred.succeed(secondStarted, undefined);
        return entry("newer");
      });

    yield* Effect.gen(function* () {
      const inventory = yield* PortableSkillsInventory;
      const first = yield* inventory.refresh.pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      const second = yield* inventory.refresh.pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      assert.equal(yield* Ref.get(calls), 2);
      assert.isTrue(Option.isNone(yield* Deferred.poll(secondStarted)));

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Deferred.await(secondStarted);
      yield* Fiber.join(second);
      assert.deepEqual(
        (yield* inventory.get).map(({ name }) => name),
        ["newer"],
      );
    }).pipe(Effect.provide(makePortableSkillsInventoryLayer({ scanInventory })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

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

const TestJsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const encodeTestJsonRecord = Schema.encodeEffect(Schema.fromJsonString(TestJsonRecord));
const decodeTestJsonRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(TestJsonRecord));

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
        path.join(homeDir, ".agents", "skills", "local-helper"),
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
      assert.deepEqual(entries[1]?.agents, ["codex", "cursor", "grok", "opencode"]);
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

  it.effect("reports Agy only when its documented global config registers the shared root", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-agy-config-" });
      const homeDir = path.join(tempDir, "home");
      yield* writeSkill(path.join(homeDir, ".agents", "skills", "review"), frontmatter("review"));

      const before = yield* readSkillsInventory({ homeDir });
      assert.notInclude(before[0]?.agents ?? [], "agy");

      const registered = yield* ensureAgySkillsRegistration({ homeDir });
      assert.deepEqual(registered, {
        ok: true,
        changed: true,
        configPath: path.join(homeDir, ".gemini", "config", "skills.json"),
      });
      const after = yield* readSkillsInventory({ homeDir });
      assert.include(after[0]?.agents ?? [], "agy");
    }),
  );
});

it.layer(NodeServices.layer)("Agy skills registration", (it) => {
  it.effect("preserves existing config values and is idempotent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-agy-config-" });
      const homeDir = path.join(tempDir, "home");
      const configPath = path.join(homeDir, ".gemini", "config", "skills.json");
      yield* fs.makeDirectory(path.dirname(configPath), { recursive: true });
      yield* fs.writeFileString(
        configPath,
        yield* encodeTestJsonRecord({
          inherits: [{ path: "/team/skills.json", include_only: ["review"] }],
          entries: [{ path: "/existing/skills", exclude: ["private"] }],
          extensionField: { retained: true },
        }),
      );

      const first = yield* ensureAgySkillsRegistration({ homeDir });
      assert.equal(first.ok && first.changed, true);
      const decoded = yield* decodeTestJsonRecord(yield* fs.readFileString(configPath));
      assert.deepEqual(decoded.inherits, [{ path: "/team/skills.json", include_only: ["review"] }]);
      assert.deepEqual(decoded.extensionField, { retained: true });
      assert.deepEqual(decoded.entries, [
        { path: "/existing/skills", exclude: ["private"] },
        { path: path.join(homeDir, ".agents", "skills") },
      ]);

      const once = yield* fs.readFileString(configPath);
      assert.deepEqual(yield* ensureAgySkillsRegistration({ homeDir }), {
        ok: true,
        changed: false,
        configPath,
      });
      assert.equal(yield* fs.readFileString(configPath), once);
    }),
  );

  it.effect("leaves malformed config untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-agy-config-" });
      const homeDir = path.join(tempDir, "home");
      const configPath = path.join(homeDir, ".gemini", "config", "skills.json");
      yield* fs.makeDirectory(path.dirname(configPath), { recursive: true });
      yield* fs.writeFileString(configPath, "{ malformed");

      const result = yield* ensureAgySkillsRegistration({ homeDir });
      assert.isFalse(result.ok);
      assert.equal(yield* fs.readFileString(configPath), "{ malformed");
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
        .exists(path.join(homeDir, ".agents", "skills"))
        .pipe(Effect.orElseSucceed(() => false));
      assert.equal(codexExists, false);
    }),
  );

  it.effect("rejects a source that lexically sits in a root but resolves outside it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-share-" });
      const homeDir = path.join(tempDir, "home");

      // A "skill" that is really a symlink to a directory outside every root
      // (the private-keys scenario). The lexical path passes; the realpath
      // must not.
      const secrets = path.join(tempDir, "secrets");
      yield* fs.makeDirectory(secrets, { recursive: true });
      yield* fs.writeFileString(path.join(secrets, "id_ed25519"), "PRIVATE");
      const skillsRoot = path.join(homeDir, ".claude", "skills");
      yield* fs.makeDirectory(skillsRoot, { recursive: true });
      yield* fs.symlink(secrets, path.join(skillsRoot, "planted"));

      const result = yield* shareSkill(
        { sourcePath: path.join(skillsRoot, "planted"), targetRoot: "codex-user" },
        { homeDir },
      );
      assert.equal(result.ok, false);
      assert.equal(result.ok === false ? result.status : 0, 400);

      // Nothing may have been linked or copied into the codex root.
      const leaked = yield* fs
        .exists(path.join(homeDir, ".agents", "skills", "planted"))
        .pipe(Effect.orElseSucceed(() => false));
      assert.equal(leaked, false);
    }),
  );

  it.effect("rejects user and project roots whose realpaths escape their boundaries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-root-escape-" });
      const homeDir = path.join(tempDir, "home");
      const cwd = path.join(tempDir, "workspace");
      const outsideUser = path.join(tempDir, "outside-user");
      const outsideProject = path.join(tempDir, "outside-project");
      const source = path.join(homeDir, ".claude", "skills", "review");
      yield* writeSkill(source, frontmatter("review"));
      yield* fs.makeDirectory(path.join(homeDir, ".agents"), { recursive: true });
      yield* fs.makeDirectory(path.join(cwd, ".agents"), { recursive: true });
      yield* fs.makeDirectory(outsideUser, { recursive: true });
      yield* fs.makeDirectory(outsideProject, { recursive: true });
      yield* fs.symlink(outsideUser, path.join(homeDir, ".agents", "skills"));
      yield* fs.symlink(outsideProject, path.join(cwd, ".agents", "skills"));

      const user = yield* shareSkill(
        { sourcePath: source, targetRoot: "codex-user" },
        { homeDir, cwd },
      );
      const project = yield* shareSkill(
        { sourcePath: source, targetRoot: "project" },
        { homeDir, cwd },
      );
      assert.isFalse(user.ok);
      assert.isFalse(project.ok);
      assert.isFalse(yield* fs.exists(path.join(outsideUser, "review")));
      assert.isFalse(yield* fs.exists(path.join(outsideProject, "review")));

      yield* writeSkill(path.join(outsideUser, "escaped"), frontmatter("escaped"));
      assert.notInclude(
        (yield* readSkillsInventory({ homeDir, cwd })).map(({ name }) => name),
        "escaped",
      );
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
      const shared = path.join(homeDir, ".agents", "skills", "copywriting");
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
        path.join(homeDir, ".agents", "skills", "review"),
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
        path.join(homeDir, ".agents", "skills", "review", "SKILL.md"),
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

it.effect("serializes direct share and refresh as one real-filesystem lifecycle", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-share-lock-" });
    const homeDir = path.join(tempDir, "home");
    const source = path.join(homeDir, ".claude", "skills", "review");
    yield* writeSkill(source, frontmatter("review"));

    yield* Effect.gen(function* () {
      const results = yield* Effect.all(
        [
          shareSkillAndRefreshInventory(
            { sourcePath: source, targetRoot: "codex-user" },
            { homeDir },
          ),
          shareSkillAndRefreshInventory(
            { sourcePath: source, targetRoot: "codex-user" },
            { homeDir },
          ),
        ],
        { concurrency: 2 },
      );
      assert.equal(results.filter(({ ok }) => ok).length, 1);
      assert.deepEqual(
        results.filter((result) => !result.ok).map((result) => (result.ok ? 0 : result.status)),
        [409],
      );
      const inventory = yield* PortableSkillsInventory;
      assert.deepEqual(
        (yield* inventory.get).map(({ name }) => name),
        ["review", "review"],
      );
      assert.match(
        yield* fs.readFileString(path.join(homeDir, ".agents", "skills", "review", "SKILL.md")),
        /name: review/,
      );
    }).pipe(Effect.provide(makePortableSkillsInventoryLayer({ homeDir })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// The product guarantee: a skill added through Settings must be usable by
// EVERY CLI that supports the SKILL.md convention, not just the root it landed
// in. This drives the same fan-out the install performs and then asserts the
// inventory really reports every compatible agent seeing it.
it.effect("installs through the production transaction into every supported agent root", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-fanout-" });
    const homeDir = path.join(tempDir, "home");
    const repoDir = path.join(tempDir, "repo");

    yield* writeSkill(
      path.join(repoDir, "skills", "shared-skill"),
      frontmatter("shared-skill", "Usable everywhere."),
    );

    const installed = yield* installSkillsFromRepository(
      { repoDir, sourceUrl: "https://example.test/shared.git" },
      { homeDir },
    );
    assert.deepEqual(installed, {
      ok: true,
      installed: ["shared-skill"],
      sharedRoots: ["claude-user", "junie-user", "agy-user"],
    });

    const inventory = yield* readSkillsInventory({ homeDir });
    const agentsSeeingIt = new Set(
      inventory.flatMap((entry) => (entry.name === "shared-skill" ? entry.agents : [])),
    );
    // Every CLI with skills support must see it; a missing one is a real gap.
    assert.isTrue(agentsSeeingIt.has("claude"), "claude must see the skill");
    assert.isTrue(agentsSeeingIt.has("codex"), "codex must see the skill");
    assert.isTrue(agentsSeeingIt.has("cursor"), "cursor must see the skill");
    assert.isTrue(agentsSeeingIt.has("grok"), "grok must see the skill");
    assert.isTrue(agentsSeeingIt.has("opencode"), "opencode must see the skill");
    assert.isTrue(agentsSeeingIt.has("junie"), "junie must see the skill");
    assert.isTrue(agentsSeeingIt.has("agy"), "agy must see the skill");

    // File-backed CLIs can reach the manifest; Agy reaches the same canonical
    // directory through its documented global registry.
    for (const rootDir of [
      path.join(homeDir, ".claude", "skills", "shared-skill", "SKILL.md"),
      path.join(homeDir, ".agents", "skills", "shared-skill", "SKILL.md"),
      path.join(homeDir, ".junie", "skills", "shared-skill", "SKILL.md"),
    ]) {
      assert.isTrue(yield* fs.exists(rootDir), `${rootDir} should exist`);
    }
    const agyConfig = yield* fs.readFileString(
      path.join(homeDir, ".gemini", "config", "skills.json"),
    );
    assert.include(agyConfig, path.join(homeDir, ".agents", "skills"));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "runs clone, portable fan-out, manifest detection, and explicit Agy install as one flow",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-git-flow-" });
      const homeDir = path.join(tempDir, "home");
      const agyCalls = yield* Ref.make<string[]>([]);
      const writeCloneSkill = (directory: string, contents: string) =>
        writeSkill(directory, contents).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.orDie,
        );

      const result = yield* installSkillFromGit(
        { url: "https://example.test/bundle.git", installAgyPlugin: true },
        { homeDir },
        {
          cloneRepository: (url, targetDir) =>
            Effect.gen(function* () {
              assert.equal(url, "https://example.test/bundle.git");
              yield* writeCloneSkill(
                path.join(targetDir, "skills", "bundle"),
                frontmatter("bundle", "A cloned skill."),
              );
              yield* fs
                .writeFileString(path.join(targetDir, "plugin.json"), "{}")
                .pipe(Effect.orDie);
              return true;
            }),
          installAgyPlugin: (url) =>
            Ref.update(agyCalls, (calls) => [...calls, url]).pipe(Effect.as("installed" as const)),
        },
      );

      assert.deepEqual(result, {
        ok: true,
        installed: ["bundle"],
        sharedRoots: ["claude-user", "junie-user", "agy-user"],
        agyPlugin: "installed",
      });
      assert.deepEqual(yield* Ref.get(agyCalls), ["https://example.test/bundle.git"]);
      for (const root of [".agents", ".claude", ".junie"] as const) {
        assert.isTrue(yield* fs.exists(path.join(homeDir, root, "skills", "bundle", "SKILL.md")));
      }
      assert.include(
        yield* fs.readFileString(path.join(homeDir, ".gemini", "config", "skills.json")),
        path.join(homeDir, ".agents", "skills"),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps Agy outcomes explicit and never invokes it without opt-in", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-agy-outcomes-" });
    const writeCloneSkill = (directory: string, contents: string) =>
      writeSkill(directory, contents).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.orDie,
      );
    const outcomes = ["agy-unavailable", "failed"] as const;

    for (const [index, outcome] of outcomes.entries()) {
      const calls = yield* Ref.make(0);
      const homeDir = path.join(tempDir, `home-${index}`);
      const result = yield* installSkillFromGit(
        { url: `https://example.test/plugin-${index}.git`, installAgyPlugin: true },
        { homeDir },
        {
          cloneRepository: (_url, targetDir) =>
            writeCloneSkill(
              path.join(targetDir, "skills", `plugin-${index}`),
              frontmatter(`plugin-${index}`),
            ).pipe(
              Effect.andThen(
                fs.writeFileString(path.join(targetDir, "plugin.json"), "{}").pipe(Effect.orDie),
              ),
              Effect.as(true),
            ),
          installAgyPlugin: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as(outcome)),
        },
      );
      assert.equal(result.ok && result.agyPlugin, outcome);
      assert.equal(yield* Ref.get(calls), 1);
    }

    const calls = yield* Ref.make(0);
    const optedOut = yield* installSkillFromGit(
      { url: "https://example.test/portable-only.git" },
      { homeDir: path.join(tempDir, "home-opted-out") },
      {
        cloneRepository: (_url, targetDir) =>
          writeCloneSkill(
            path.join(targetDir, "skills", "portable-only"),
            frontmatter("portable-only"),
          ).pipe(
            Effect.andThen(
              fs.writeFileString(path.join(targetDir, "plugin.json"), "{}").pipe(Effect.orDie),
            ),
            Effect.as(true),
          ),
        installAgyPlugin: () =>
          Ref.update(calls, (count) => count + 1).pipe(Effect.as("installed" as const)),
      },
    );
    assert.equal(optedOut.ok && optedOut.agyPlugin, "not-requested");
    assert.equal(yield* Ref.get(calls), 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("serializes clone and Agy mutation across concurrent git installs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-lifecycle-lock-" });
    const active = yield* Ref.make(0);
    const maximum = yield* Ref.make(0);
    const enter = Ref.updateAndGet(active, (count) => count + 1).pipe(
      Effect.tap((count) => Ref.update(maximum, (value) => Math.max(value, count))),
      Effect.andThen(Effect.yieldNow),
      Effect.andThen(Effect.yieldNow),
    );
    const leave = Ref.update(active, (count) => count - 1);
    const writeCloneSkill = (directory: string, contents: string) =>
      writeSkill(directory, contents).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.orDie,
      );

    const makeInstall = (name: string) =>
      installSkillFromGit(
        { url: `https://example.test/${name}.git`, installAgyPlugin: true },
        { homeDir: path.join(tempDir, "home") },
        {
          cloneRepository: (_url, targetDir) =>
            enter.pipe(
              Effect.andThen(
                writeCloneSkill(path.join(targetDir, "skills", name), frontmatter(name)),
              ),
              Effect.andThen(
                fs.writeFileString(path.join(targetDir, "plugin.json"), "{}").pipe(Effect.orDie),
              ),
              Effect.ensuring(leave),
              Effect.as(true),
            ),
          installAgyPlugin: () =>
            enter.pipe(Effect.ensuring(leave), Effect.as("installed" as const)),
        },
      );

    const results = yield* Effect.all([makeInstall("alpha"), makeInstall("beta")], {
      concurrency: "unbounded",
    });
    assert.isTrue(results.every((result) => result.ok));
    assert.equal(yield* Ref.get(maximum), 1);
    assert.equal(yield* Ref.get(active), 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("derives a root skill name from its repository URL, not the checkout directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-root-layout-" });
    const homeDir = path.join(tempDir, "home");
    const checkoutDir = path.join(tempDir, "arbitrary-checkout-name");
    yield* writeSkill(checkoutDir, frontmatter("portable-root-skill"));

    const installed = yield* installSkillsFromRepository(
      { repoDir: checkoutDir, sourceUrl: "https://example.test/portable-root-skill.git" },
      { homeDir },
    );

    assert.deepEqual(installed, {
      ok: true,
      installed: ["portable-root-skill"],
      sharedRoots: ["claude-user", "junie-user", "agy-user"],
    });
    for (const root of [".claude", ".agents", ".junie"] as const) {
      assert.isTrue(
        yield* fs.exists(path.join(homeDir, root, "skills", "portable-root-skill", "SKILL.md")),
      );
      assert.isFalse(
        yield* fs.exists(path.join(homeDir, root, "skills", "arbitrary-checkout-name", "SKILL.md")),
      );
    }
    assert.include(
      yield* fs.readFileString(path.join(homeDir, ".gemini", "config", "skills.json")),
      path.join(homeDir, ".agents", "skills"),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preflights all names and leaves no partial install when a later skill conflicts", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-atomic-" });
    const homeDir = path.join(tempDir, "home");
    const repoDir = path.join(tempDir, "repo");
    yield* writeSkill(path.join(repoDir, "skills", "alpha"), frontmatter("alpha"));
    yield* writeSkill(path.join(repoDir, "skills", "zeta"), frontmatter("zeta"));
    yield* writeSkill(
      path.join(homeDir, ".junie", "skills", "zeta"),
      frontmatter("zeta", "pre-existing"),
    );

    const result = yield* installSkillsFromRepository(
      { repoDir, sourceUrl: "https://example.test/multi.git" },
      { homeDir },
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok ? 0 : result.status, 409);

    for (const root of [".claude", ".agents", ".junie"] as const) {
      assert.isFalse(
        yield* fs.exists(path.join(homeDir, root, "skills", "alpha")),
        `${root} must not receive an earlier skill from a rejected transaction`,
      );
    }
    assert.include(
      yield* fs.readFileString(path.join(homeDir, ".junie", "skills", "zeta", "SKILL.md")),
      "pre-existing",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("serializes simultaneous same-name installs without rolling back the winner", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-concurrent-" });
    const homeDir = path.join(tempDir, "home");
    const repoA = path.join(tempDir, "repo-a");
    const repoB = path.join(tempDir, "repo-b");
    yield* writeSkill(path.join(repoA, "skills", "shared"), frontmatter("shared", "first"));
    yield* writeSkill(path.join(repoB, "skills", "shared"), frontmatter("shared", "second"));

    const results = yield* Effect.all(
      [
        installSkillsFromRepository(
          { repoDir: repoA, sourceUrl: "https://example.test/a.git" },
          { homeDir },
        ),
        installSkillsFromRepository(
          { repoDir: repoB, sourceUrl: "https://example.test/b.git" },
          { homeDir },
        ),
      ],
      { concurrency: 2 },
    );

    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.deepEqual(
      results.filter((result) => !result.ok).map((result) => (result.ok ? 0 : result.status)),
      [409],
    );
    for (const root of [".agents", ".claude", ".junie"] as const) {
      assert.isTrue(yield* fs.exists(path.join(homeDir, root, "skills", "shared", "SKILL.md")));
    }
    assert.include(
      yield* fs.readFileString(path.join(homeDir, ".gemini", "config", "skills.json")),
      path.join(homeDir, ".agents", "skills"),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects non-portable names and skill symlinks that escape the cloned repository", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-source-guard-" });
    const homeDir = path.join(tempDir, "home");

    const badNameRepo = path.join(tempDir, "bad-name-repo");
    yield* writeSkill(path.join(badNameRepo, "skills", "bad name"), frontmatter("bad-name"));
    const badName = yield* installSkillsFromRepository(
      { repoDir: badNameRepo, sourceUrl: "https://example.test/bad.git" },
      { homeDir },
    );
    assert.equal(badName.ok, false);
    assert.equal(badName.ok ? 0 : badName.status, 400);

    const outside = path.join(tempDir, "outside");
    yield* writeSkill(outside, frontmatter("escaped"));
    const symlinkRepo = path.join(tempDir, "symlink-repo");
    yield* fs.makeDirectory(path.join(symlinkRepo, "skills"), { recursive: true });
    yield* fs.symlink(outside, path.join(symlinkRepo, "skills", "escaped"));
    const escaped = yield* installSkillsFromRepository(
      { repoDir: symlinkRepo, sourceUrl: "https://example.test/escaped.git" },
      { homeDir },
    );
    assert.equal(escaped.ok, false);
    assert.match(escaped.ok ? "" : escaped.message, /outside the cloned repository/);
    assert.isFalse(yield* fs.exists(path.join(homeDir, ".claude", "skills", "escaped")));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not overwrite a skill of the same name already in a target root", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectory({ prefix: "t3-skills-collide-" });
    const homeDir = path.join(tempDir, "home");
    const source = path.join(homeDir, ".claude", "skills", "dup");
    yield* writeSkill(source, frontmatter("dup", "new one"));
    // A different skill already owns that name for codex.
    yield* writeSkill(
      path.join(homeDir, ".agents", "skills", "dup"),
      frontmatter("dup", "existing"),
    );

    const shared = yield* shareSkill({ sourcePath: source, targetRoot: "codex-user" }, { homeDir });
    assert.isFalse(shared.ok, "an existing skill must never be clobbered");

    const existing = yield* fs.readFileString(
      path.join(homeDir, ".agents", "skills", "dup", "SKILL.md"),
    );
    assert.include(existing, "existing");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.layer(NodeServices.layer)("reconcileUserSkills", (it) => {
  it.effect("automatically shares a Claude-only skill with every compatible CLI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-reconcile-" });
      const homeDir = path.join(tempDir, "home");
      const claudeSkill = path.join(homeDir, ".claude", "skills", "focus-mode");
      yield* writeSkill(claudeSkill, frontmatter("focus-mode", "Focused working mode."));

      const first = yield* reconcileUserSkills({ homeDir });
      assert.deepEqual(first, {
        shared: [
          { name: "focus-mode", targetRoot: "codex-user", mode: "symlink" },
          { name: "focus-mode", targetRoot: "junie-user", mode: "symlink" },
          { name: "focus-mode", targetRoot: "agy-user", mode: "config" },
        ],
        conflicts: [],
        failures: [],
      });

      const canonical = path.join(homeDir, ".agents", "skills", "focus-mode");
      const junie = path.join(homeDir, ".junie", "skills", "focus-mode");
      assert.equal(yield* fs.realPath(canonical), yield* fs.realPath(claudeSkill));
      assert.equal(yield* fs.realPath(junie), yield* fs.realPath(claudeSkill));
      assert.include(
        yield* fs.readFileString(path.join(homeDir, ".gemini", "config", "skills.json")),
        path.join(homeDir, ".agents", "skills"),
      );

      const inventory = yield* readSkillsInventory({ homeDir });
      const agentsSeeingSkill = new Set(
        inventory.flatMap((entry) => (entry.name === "focus-mode" ? entry.agents : [])),
      );
      assert.deepEqual([...agentsSeeingSkill].sort(), [
        "agy",
        "claude",
        "codex",
        "cursor",
        "grok",
        "junie",
        "opencode",
      ]);

      // Re-running startup reconciliation must be a true no-op: no duplicate
      // links, no false conflicts, and no dependence on user confirmation.
      assert.deepEqual(yield* reconcileUserSkills({ homeDir }), {
        shared: [],
        conflicts: [],
        failures: [],
      });
    }),
  );

  it.effect("migrates skills written by the obsolete d4 Codex path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-legacy-" });
      const homeDir = path.join(tempDir, "home");
      const legacy = path.join(homeDir, ".codex", "skills", "legacy-helper");
      yield* writeSkill(legacy, frontmatter("legacy-helper", "Installed by an older d4 build."));

      const result = yield* reconcileUserSkills({ homeDir });
      assert.deepEqual(
        result.shared.map(({ name, targetRoot }) => [name, targetRoot]),
        [
          ["legacy-helper", "codex-user"],
          ["legacy-helper", "claude-user"],
          ["legacy-helper", "junie-user"],
          ["legacy-helper", "agy-user"],
        ],
      );
      assert.deepEqual(result.conflicts, []);
      assert.deepEqual(result.failures, []);

      for (const manifest of [
        path.join(homeDir, ".agents", "skills", "legacy-helper", "SKILL.md"),
        path.join(homeDir, ".claude", "skills", "legacy-helper", "SKILL.md"),
        path.join(homeDir, ".junie", "skills", "legacy-helper", "SKILL.md"),
      ]) {
        assert.isTrue(yield* fs.exists(manifest), `${manifest} should be readable`);
      }
      assert.include(
        yield* fs.readFileString(path.join(homeDir, ".gemini", "config", "skills.json")),
        path.join(homeDir, ".agents", "skills"),
      );
    }),
  );

  it.effect("keeps the shared root authoritative without overwriting a divergent skill", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-conflict-" });
      const homeDir = path.join(tempDir, "home");
      const canonical = path.join(homeDir, ".agents", "skills", "review");
      const claude = path.join(homeDir, ".claude", "skills", "review");
      yield* writeSkill(canonical, frontmatter("review", "Canonical version."));
      yield* writeSkill(claude, frontmatter("review", "Claude-specific version."));

      const result = yield* reconcileUserSkills({ homeDir });
      assert.deepEqual(result.shared, [
        { name: "review", targetRoot: "junie-user", mode: "symlink" },
        { name: "review", targetRoot: "agy-user", mode: "config" },
      ]);
      assert.deepEqual(result.conflicts, [
        {
          name: "review",
          targetRoot: "claude-user",
          targetPath: claude,
        },
      ]);
      assert.deepEqual(result.failures, []);
      assert.include(yield* fs.readFileString(path.join(claude, "SKILL.md")), "Claude-specific");
      assert.equal(
        yield* fs.realPath(path.join(homeDir, ".junie", "skills", "review")),
        yield* fs.realPath(canonical),
      );
    }),
  );

  it.effect("reconciles a large mixed inventory deterministically and idempotently", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-stress-" });
      const homeDir = path.join(tempDir, "home");
      const skillCount = 48;

      for (let index = 0; index < skillCount; index += 1) {
        const name = `stress-${String(index).padStart(2, "0")}`;
        const sourceRoot =
          index % 3 === 0
            ? path.join(homeDir, ".claude", "skills")
            : index % 3 === 1
              ? path.join(homeDir, ".codex", "skills")
              : path.join(homeDir, ".junie", "skills");
        yield* writeSkill(path.join(sourceRoot, name), frontmatter(name, `Skill ${index}.`));
      }

      const result = yield* reconcileUserSkills({ homeDir });
      assert.equal(result.conflicts.length, 0);
      assert.equal(result.failures.length, 0);
      // Each skill gets the missing file aliases; Agy needs one global config
      // registration regardless of inventory size.
      assert.equal(result.shared.length, 113);
      assert.equal(result.shared.filter(({ targetRoot }) => targetRoot === "agy-user").length, 1);

      for (let index = 0; index < skillCount; index += 1) {
        const name = `stress-${String(index).padStart(2, "0")}`;
        for (const root of [
          path.join(homeDir, ".agents", "skills"),
          path.join(homeDir, ".claude", "skills"),
          path.join(homeDir, ".junie", "skills"),
        ]) {
          assert.isTrue(yield* fs.exists(path.join(root, name, "SKILL.md")));
        }
      }
      assert.include(
        yield* fs.readFileString(path.join(homeDir, ".gemini", "config", "skills.json")),
        path.join(homeDir, ".agents", "skills"),
      );
      assert.deepEqual(yield* reconcileUserSkills({ homeDir }), {
        shared: [],
        conflicts: [],
        failures: [],
      });
    }),
  );
});

// Agy can read portable skills through its global registry. A plugin is a second,
// broader package channel for hooks/MCP/etc., so manifest detection must stay
// exact and its outcome must be reported independently.
it.effect("detects an agy plugin manifest at the repo root", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = yield* fs.makeTempDirectory({ prefix: "agy-plugin-" });
    yield* fs.writeFileString(path.join(repo, "plugin.json"), '{"name":"x"}');
    assert.isTrue(yield* hasAgyPluginManifest(repo));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("accepts a gemini extension manifest as an agy plugin", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = yield* fs.makeTempDirectory({ prefix: "agy-gemini-" });
    yield* fs.writeFileString(path.join(repo, "gemini-extension.json"), '{"name":"x"}');
    assert.isTrue(yield* hasAgyPluginManifest(repo));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a skills-only repo as not an agy plugin", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = yield* fs.makeTempDirectory({ prefix: "agy-none-" });
    // A perfectly good skill repo, with no plugin packaging.
    yield* writeSkill(path.join(repo, "skills", "solo"), frontmatter("solo"));
    assert.isFalse(yield* hasAgyPluginManifest(repo));
  }).pipe(Effect.provide(NodeServices.layer)),
);

// A skill install clones a remote and writes instructions every agent loads,
// so URL validation is a security boundary, not a convenience.
it("accepts only https and ssh git remotes", () => {
  assert.equal(
    normalizeSkillRepoUrl("https://github.com/example/focus-mode"),
    "https://github.com/example/focus-mode",
  );
  assert.equal(
    normalizeSkillRepoUrl("git@github.com:owner/repo.git"),
    "git@github.com:owner/repo.git",
  );
  assert.isNotNull(normalizeSkillRepoUrl("ssh://git@github.com/owner/repo.git"));
});

it("refuses local-filesystem and non-git URL schemes", () => {
  // A local URL would let the installer copy arbitrary directories into the
  // skills roots that every agent then loads.
  assert.isNull(normalizeSkillRepoUrl("file:///etc/passwd"));
  assert.isNull(normalizeSkillRepoUrl("/home/user/private-material"));
  assert.isNull(normalizeSkillRepoUrl("../../etc"));
  assert.isNull(normalizeSkillRepoUrl("http://insecure.test/repo.git"));
  assert.isNull(normalizeSkillRepoUrl("javascript:alert(1)"));
  assert.isNull(normalizeSkillRepoUrl(""));
  assert.isNull(normalizeSkillRepoUrl(undefined));
  assert.isNull(normalizeSkillRepoUrl(42));
});

it("refuses an embedded userinfo component in the URL", () => {
  assert.isNull(normalizeSkillRepoUrl("https://user:secret@github.com/o/r.git"));
});

it("derives a filesystem-safe skill name from a repo URL", () => {
  assert.equal(skillNameFromRepoUrl("https://github.com/example/focus-mode"), "focus-mode");
  assert.equal(skillNameFromRepoUrl("https://github.com/o/repo.git"), "repo");
  assert.equal(skillNameFromRepoUrl("git@github.com:o/my.skill.git"), "my.skill");
});

it.effect("finds skills in the conventional skills/<name> layout", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = yield* fs.makeTempDirectory({ prefix: "skills-layout-" });
    yield* writeSkill(path.join(repo, "skills", "alpha"), frontmatter("alpha"));
    yield* writeSkill(path.join(repo, "skills", "beta"), frontmatter("beta"));
    // A non-skill directory alongside them must be ignored.
    yield* fs.makeDirectory(path.join(repo, "skills", "docs"), { recursive: true });
    const found = yield* findSkillDirectories(repo);
    assert.deepEqual(found.map((dir) => path.basename(dir)).sort(), ["alpha", "beta"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("falls back to a repo that is itself one skill", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const repo = yield* fs.makeTempDirectory({ prefix: "skills-root-" });
    yield* writeSkill(repo, frontmatter("solo"));
    assert.deepEqual(yield* findSkillDirectories(repo), [repo]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports nothing for a repo with no SKILL.md", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = yield* fs.makeTempDirectory({ prefix: "skills-empty-" });
    yield* fs.makeDirectory(path.join(repo, "src"), { recursive: true });
    assert.deepEqual(yield* findSkillDirectories(repo), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);
