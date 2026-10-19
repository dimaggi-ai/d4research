import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  readSecondBrainFile,
  readSecondBrainMap,
  searchSecondBrain,
  writeSecondBrainFile,
} from "./secondBrain.ts";

const makeBrain = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-brain-" }));
  const write = (relative: string, text: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(path.join(root, relative)), { recursive: true });
      yield* fs.writeFileString(path.join(root, relative), text);
    });
  yield* write("CLAUDE.md", "@AGENTS.md\n");
  yield* write("AGENTS.md", "# Map\n\n@MEMORY.md\n");
  yield* write("MEMORY.md", "Prefers Zinsser.\n");
  yield* write("people/ivan-petrov.md", "# Ivan\nWorks on tax policy.\n");
  yield* write("notes/tax-policy.md", "# Tax policy\nFlat rate.\n");
  yield* write(".git/notes.md", "tax secret\n");
  return { root, write };
});

const failureMessage = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.message),
  );

it.layer(NodeServices.layer)("second brain", (it) => {
  it.effect(
    "the map prefers AGENTS.md, inlines @imports, and lists Markdown outside dot dirs",
    () =>
      Effect.gen(function* () {
        const { root } = yield* makeBrain();
        const map = yield* readSecondBrainMap(root);
        assert.equal(map.mapFile, "AGENTS.md");
        assert.include(map.map, "<!-- MEMORY.md -->\nPrefers Zinsser.");
        assert.deepEqual(map.files, [
          "AGENTS.md",
          "CLAUDE.md",
          "MEMORY.md",
          "notes/tax-policy.md",
          "people/ivan-petrov.md",
        ]);
      }),
  );

  it.effect("search ranks file-name hits first and never reads dot directories", () =>
    Effect.gen(function* () {
      const { root } = yield* makeBrain();
      const results = yield* searchSecondBrain(root, "TAX", 10);
      assert.deepEqual(
        results.map((result) => [result.path, result.line]),
        [
          ["notes/tax-policy.md", undefined],
          ["notes/tax-policy.md", 1],
          ["people/ivan-petrov.md", 2],
        ],
      );
      assert.equal((yield* searchSecondBrain(root, "tax", 1)).length, 1);
    }),
  );

  it.effect("reads stay inside the root, on Markdown, outside dot directories", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root } = yield* makeBrain();
      assert.equal(
        (yield* readSecondBrainFile(root, "people/ivan-petrov.md")).path,
        "people/ivan-petrov.md",
      );
      assert.include(yield* failureMessage(readSecondBrainFile(root, "../outside.md")), "outside");
      assert.include(yield* failureMessage(readSecondBrainFile(root, "/etc/passwd")), "relative");
      assert.include(yield* failureMessage(readSecondBrainFile(root, ".git/notes.md")), "hidden");
      assert.include(yield* failureMessage(readSecondBrainFile(root, "notes/x.txt")), ".md");

      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-brain-outside-" });
      yield* fs.writeFileString(path.join(outside, "leak.md"), "leak\n");
      yield* fs.symlink(outside, path.join(root, "linked"));
      assert.include(
        yield* failureMessage(readSecondBrainFile(root, "linked/leak.md")),
        "resolves outside",
      );
      assert.include(
        yield* failureMessage(writeSecondBrainFile(root, "linked/new.md", "x", "replace")),
        "resolves outside",
      );
    }),
  );

  it.effect("writes append by line, replace whole files, and create folders", () =>
    Effect.gen(function* () {
      const { root, write } = yield* makeBrain();
      yield* write("LEARNINGS.md", "# Learnings");
      const appended = yield* writeSecondBrainFile(
        root,
        "LEARNINGS.md",
        "- 2026-10-18: one.",
        "append",
      );
      assert.isFalse(appended.created);
      assert.equal(
        (yield* readSecondBrainFile(root, "LEARNINGS.md")).content,
        "# Learnings\n- 2026-10-18: one.\n",
      );

      const created = yield* writeSecondBrainFile(root, "projects/d4.md", "# d4", "replace");
      assert.isTrue(created.created);
      yield* writeSecondBrainFile(root, "projects/d4.md", "# d4 v2\n", "replace");
      assert.equal((yield* readSecondBrainFile(root, "projects/d4.md")).content, "# d4 v2\n");
    }),
  );
});
