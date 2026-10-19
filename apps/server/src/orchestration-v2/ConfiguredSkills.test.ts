import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@d4research/contracts";
import { extractTrailingEnabledSkillsContext } from "@d4research/shared/enabledSkillsContext";
import {
  appendProviderHandoffContext,
  extractTrailingProviderHandoffContext,
} from "@d4research/shared/providerHandoffPrompt";
import { Effect, FileSystem, Path } from "effect";
import { appendConfiguredSkillsToMessage } from "./ConfiguredSkills.ts";

it.effect(
  "resolves global and chat skills with project priority and preserves prompt envelopes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDir = yield* fs.makeTempDirectoryScoped({ prefix: "d4-configured-skills-" });
        const cwd = path.join(homeDir, "project");
        const write = (directory: string, name: string) =>
          fs
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.andThen(
                fs.writeFileString(
                  path.join(directory, "SKILL.md"),
                  `---\nname: ${name}\ndescription: Test skill\n---\nInstructions`,
                ),
              ),
            );
        yield* write(path.join(homeDir, ".agents", "skills", "global"), "global");
        yield* write(path.join(cwd, ".agents", "skills", "global"), "global");
        yield* write(path.join(homeDir, ".claude", "skills", "session"), "session");
        const threadId = ThreadId.make("thread");
        const skills = {
          enabledByDefault: ["global", "missing"],
          enabledByThread: { [threadId]: ["global", "session"] },
        };
        const handoff = appendProviderHandoffContext("Continue the task", {
          sourceThreadId: "source",
          sourceThreadTitle: "Source",
          summary: "Exact context\nwith lines.",
          targetInstanceId: "codex",
          targetModel: "model",
        });
        for (const text of ["/compact", "!research:audit Explain this", handoff]) {
          const result = yield* appendConfiguredSkillsToMessage({
            text,
            threadId,
            cwd,
            homeDir,
            skills,
          });
          const extracted = extractTrailingEnabledSkillsContext(result);
          assert.equal(extracted.promptText, text);
          assert.deepEqual(extracted.globalSkills, ["global"]);
          assert.deepEqual(extracted.sessionSkills, ["session"]);
          assert.include(result, path.join(cwd, ".agents", "skills", "global", "SKILL.md"));
          assert.deepEqual(
            extractTrailingProviderHandoffContext(extracted.promptText),
            extractTrailingProviderHandoffContext(text),
          );
          assert.equal(
            yield* appendConfiguredSkillsToMessage({
              text: result,
              threadId,
              cwd,
              homeDir,
              skills,
            }),
            result,
          );
          assert.equal(
            yield* appendConfiguredSkillsToMessage({
              text: result,
              threadId,
              cwd,
              homeDir,
              skills: { enabledByDefault: [], enabledByThread: {} },
            }),
            text,
          );
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
