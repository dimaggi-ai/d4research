import type { ServerSettings, ThreadId } from "@d4research/contracts";
import {
  appendEnabledSkillsContext,
  mergeEnabledSkillNames,
  extractTrailingEnabledSkillsContext,
} from "@d4research/shared/enabledSkillsContext";
import { Effect, FileSystem } from "effect";
import { readSkillsInventory, type SkillsInventoryRoot } from "../skillsInventory.ts";

/** Preserve the accepted skill snapshot when a provider-bound prompt is expanded. */
export function withPersistedSkillsContext(text: string, acceptedText: string): string {
  const { promptText } = extractTrailingEnabledSkillsContext(acceptedText);
  return (
    extractTrailingEnabledSkillsContext(text).promptText + acceptedText.slice(promptText.length)
  );
}

const priority: Readonly<Record<SkillsInventoryRoot, number>> = {
  project: 0,
  "codex-user": 1,
  "claude-user": 2,
  "junie-user": 3,
  "agy-user": 4,
};

/** Append references after client context, without modifying the handoff or pipeline envelope. */
export const appendConfiguredSkillsToMessage = Effect.fn("appendConfiguredSkillsToMessage")(
  function* (input: {
    readonly text: string;
    readonly threadId: ThreadId;
    readonly cwd: string | null;
    readonly skills: ServerSettings["skills"];
    /** Same isolated inventory override supported by readSkillsInventory. */
    readonly homeDir?: string;
  }) {
    return yield* Effect.gen(function* () {
      const names = mergeEnabledSkillNames(
        input.skills.enabledByDefault,
        input.skills.enabledByThread[input.threadId] ?? [],
      );
      if (names.length === 0) return appendEnabledSkillsContext(input.text, []);
      const fileSystem = yield* FileSystem.FileSystem;
      const inventory = yield* readSkillsInventory({
        ...(input.cwd === null ? {} : { cwd: input.cwd }),
        ...(input.homeDir === undefined ? {} : { homeDir: input.homeDir }),
      });
      const candidates = inventory
        .filter((entry) => entry.kind === "skill" && names.includes(entry.name))
        .sort((left, right) => priority[left.root] - priority[right.root]);
      const global = new Set(input.skills.enabledByDefault);
      const references = yield* Effect.forEach(names, (name) =>
        Effect.gen(function* () {
          const entry = candidates.find((candidate) => candidate.name === name);
          if (
            !entry ||
            !(yield* fileSystem.exists(entry.path).pipe(Effect.orElseSucceed(() => false)))
          )
            return null;
          return {
            name,
            path: entry.path,
            description: entry.description,
            scope: global.has(name) ? ("global" as const) : ("session" as const),
          };
        }),
      );
      return appendEnabledSkillsContext(
        input.text,
        references.filter((reference) => reference !== null),
      );
    }).pipe(Effect.catchCause(() => Effect.succeed(input.text)));
  },
);
