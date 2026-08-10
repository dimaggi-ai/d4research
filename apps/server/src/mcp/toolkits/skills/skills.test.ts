import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverClaudeSkills } from "../../../provider/Drivers/ClaudeSkills.ts";
import { readSkillsInventory, shareSkill } from "../../../skillsInventory.ts";
import { searchSkillsInventory } from "./handlers.ts";

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

it.layer(NodeServices.layer)("skills_search", (it) => {
  it.effect("answers from a live inventory scan with paths and visible agents", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-search-" });
      const homeDir = path.join(tempDir, "home");
      yield* writeSkill(
        path.join(homeDir, ".claude", "skills", "security-review"),
        frontmatter("security-review", "Review code for vulnerabilities."),
      );
      yield* writeSkill(
        path.join(homeDir, ".agents", "skills", "storyboard"),
        frontmatter("storyboard", "Build a shot list."),
      );

      const entries = yield* readSkillsInventory({ homeDir });
      const byName = searchSkillsInventory(entries, "storyboard", 10);
      assert.equal(byName.length, 1);
      assert.equal(byName[0]?.name, "storyboard");
      assert.equal(
        byName[0]?.path,
        path.join(homeDir, ".agents", "skills", "storyboard", "SKILL.md"),
      );
      assert.deepEqual(byName[0]?.agents, ["codex", "cursor", "grok", "opencode"]);

      // Description hits are found too, and rank behind name hits.
      const byDescription = searchSkillsInventory(entries, "vulnerabilities", 10);
      assert.deepEqual(
        byDescription.map((result) => result.name),
        ["security-review"],
      );

      // An empty query lists everything, and the limit is honoured.
      assert.equal(searchSkillsInventory(entries, "", 10).length, 2);
      assert.equal(searchSkillsInventory(entries, "", 1).length, 1);

      // A deleted skill disappears immediately — no index to go stale.
      yield* fs.remove(path.join(homeDir, ".agents", "skills", "storyboard"), { recursive: true });
      const rescanned = yield* readSkillsInventory({ homeDir });
      assert.deepEqual(
        searchSkillsInventory(rescanned, "storyboard", 10).map((result) => result.name),
        [],
      );
    }),
  );

  it.effect("a skill shared into the Claude home becomes natively visible to Claude", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-share-" });
      const homeDir = path.join(tempDir, "home");
      const sourceDirectory = path.join(homeDir, ".agents", "skills", "storyboard");
      yield* writeSkill(sourceDirectory, frontmatter("storyboard", "Build a shot list."));
      yield* fs.makeDirectory(path.join(homeDir, ".claude", "skills"), { recursive: true });

      const shared = yield* shareSkill(
        { sourcePath: sourceDirectory, targetRoot: "claude-user" },
        { homeDir },
      );
      assert.isTrue(shared.ok);

      // Round trip through Claude's own discovery, not just our inventory.
      const claudeSkills = yield* discoverClaudeSkills(
        { homePath: path.join(homeDir, ".claude") },
        undefined,
        { HOME: homeDir },
      );
      assert.include(
        claudeSkills.map((skill) => skill.name),
        "storyboard",
      );
    }),
  );
});
