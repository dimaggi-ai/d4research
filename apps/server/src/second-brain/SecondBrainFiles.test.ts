import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Files from "./SecondBrainFiles.ts";
import { withBrain } from "./testkit.ts";
import { NOTE_BYTES } from "./noteDocument.ts";

it.effect("refuses traversal, hidden components, absolute paths and non-Markdown", () =>
  withBrain((root) =>
    Effect.gen(function* () {
      const files = yield* Files.SecondBrainFiles;
      for (const name of [
        "../escape.md",
        "/tmp/escape.md",
        ".secret/a.md",
        "a/../b.md",
        "a.txt",
        "a\\b.md",
      ]) {
        const result = yield* files.read(root, name).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
      }
    }),
  ),
);
it.effect(
  "refuses file, directory, dangling and map symlinks while accepting a symlinked root",
  () =>
    withBrain((root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const files = yield* Files.SecondBrainFiles;
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "brain-outside-" });
        yield* fs.writeFileString(`${outside}/secret.md`, "private");
        yield* fs.symlink(root, `${outside}/root`);
        expect(yield* files.root(`${outside}/root`)).toBe(root);
        for (const [name, target] of [
          ["AGENTS.md", `${outside}/secret.md`],
          ["link", outside],
          ["dead.md", `${outside}/missing`],
        ]) {
          yield* fs.symlink(target!, `${root}/${name}`);
          expect((yield* files.walk(root).pipe(Effect.result))._tag).toBe("Failure");
          expect(
            (yield* files
              .read(root, name === "link" ? "link/secret.md" : name!)
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(
            (yield* files
              .write(root, name === "link" ? "link/new.md" : name!, "no", null)
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          yield* fs.remove(`${root}/${name}`);
        }
        expect(yield* fs.readFileString(`${outside}/secret.md`)).toBe("private");
      }),
    ),
);
it.effect("enforces size caps and preserves revisions on stale writes", () =>
  withBrain((root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = yield* Files.SecondBrainFiles;
      yield* fs.writeFileString(`${root}/large.md`, "x".repeat(NOTE_BYTES + 1));
      const large = yield* files.read(root, "large.md").pipe(Effect.result);
      expect(large._tag).toBe("Failure");
      const first = yield* files.write(root, "notes/a.md", "one", null);
      const writes = yield* Effect.all(
        [
          files.write(root, "notes/a.md", "two", first.hash).pipe(Effect.result),
          files.write(root, "notes/a.md", "three", first.hash).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(writes.filter((x) => x._tag === "Success")).toHaveLength(1);
      expect(writes.filter((x) => x._tag === "Failure")).toHaveLength(1);
      expect(yield* fs.readDirectory(`${root}/notes`)).toEqual(["a.md"]);
    }),
  ),
);
it.effect("reports depth truncation", () =>
  withBrain((root) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const files = yield* Files.SecondBrainFiles;
      const nested = Array.from({ length: 18 }, () => "a").join("/");
      yield* fs.makeDirectory(`${root}/${nested}`, { recursive: true });
      yield* fs.writeFileString(`${root}/${nested}/x.md`, "x");
      expect((yield* files.walk(root)).truncated).toBe(true);
    }),
  ),
);
