import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { extractTrailingEnabledSkillsContext } from "@t3tools/shared/enabledSkillsContext";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { canonicalizeClientCommandTimestamps, normalizeDispatchCommand } from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

const turnStartCommand = (
  text: string,
  instanceId = ProviderInstanceId.make("agy"),
): Extract<ClientOrchestrationCommand, { readonly type: "thread.turn.start" }> => ({
  type: "thread.turn.start",
  commandId: CommandId.make("command-skills"),
  threadId: ThreadId.make("thread-skills"),
  message: {
    messageId: MessageId.make("message-skills"),
    role: "user",
    text,
    attachments: [],
  },
  modelSelection: {
    instanceId,
    model: "agy-default",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: clientCreatedAt,
});

/**
 * Run one dispatch normalization against a throwaway home holding a single
 * user-level Claude skill. The inventory resolves its home through
 * os.homedir(), which reads HOME on POSIX.
 */
const normalizeWithSkillHome = Effect.fn(function* (
  text: string,
  enabledByDefault: ReadonlyArray<string> = [],
  enabledByThread: Readonly<Record<string, ReadonlyArray<string>>> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-normalizer-skills-" });
  const homeDir = path.join(tempDir, "home");
  const skillDir = path.join(homeDir, ".claude", "skills", "security-review");
  yield* fs.makeDirectory(skillDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(skillDir, "SKILL.md"),
    "---\nname: security-review\ndescription: Review code for vulnerabilities.\n---\n\nBody.",
  );

  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  const command = yield* normalizeDispatchCommand(turnStartCommand(text)).pipe(
    Effect.provide(
      ServerSettings.layerTest({
        skills: {
          enabledByDefault: [...enabledByDefault],
          enabledByThread: Object.fromEntries(
            Object.entries(enabledByThread).map(([threadId, names]) => [threadId, [...names]]),
          ),
        },
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        if (previousHome === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = previousHome;
        }
      }),
    ),
  );
  return { command, skillPath: path.join(skillDir, "SKILL.md") };
});

const normalizerTestLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-config-" }),
  WorkspacePaths.layer,
).pipe(Layer.provideMerge(NodeServices.layer));

effectIt.layer(normalizerTestLayer)("normalizeDispatchCommand skill expansion", (it) => {
  it.effect("appends the skill reference block to the persisted user message", () =>
    Effect.gen(function* () {
      const { command, skillPath } = yield* normalizeWithSkillHome(
        "please run $security-review on this diff",
      );
      assert.equal(command.type, "thread.turn.start");
      if (command.type !== "thread.turn.start") return;
      assert.isTrue(command.message.text.startsWith("please run $security-review on this diff"));
      assert.include(command.message.text, skillPath);
      assert.include(command.message.text, "attaching a skill does not run it");
    }),
  );

  it.effect("leaves a message without a skill token unchanged", () =>
    Effect.gen(function* () {
      const { command } = yield* normalizeWithSkillHome("no attachments in this message");
      if (command.type !== "thread.turn.start") return;
      assert.equal(command.message.text, "no attachments in this message");
    }),
  );

  it.effect("attaches an enabled-by-default skill to an ordinary turn", () =>
    Effect.gen(function* () {
      const { command, skillPath } = yield* normalizeWithSkillHome("focus this work", [
        "security-review",
      ]);
      if (command.type !== "thread.turn.start") return;

      const extracted = extractTrailingEnabledSkillsContext(command.message.text);
      assert.deepStrictEqual(extracted.skills, ["security-review"]);
      assert.deepStrictEqual(extracted.globalSkills, ["security-review"]);
      assert.deepStrictEqual(extracted.sessionSkills, []);
      assert.equal(extracted.promptText, "focus this work");
      assert.include(command.message.text, skillPath);
      assert.include(command.message.text, "enabled by the user for this turn");
    }),
  );

  it.effect("attaches a chat skill only to the configured durable thread", () =>
    Effect.gen(function* () {
      const { command } = yield* normalizeWithSkillHome("review this chat", [], {
        "thread-skills": ["security-review"],
      });
      if (command.type !== "thread.turn.start") return;

      const extracted = extractTrailingEnabledSkillsContext(command.message.text);
      assert.deepStrictEqual(extracted.skills, ["security-review"]);
      assert.deepStrictEqual(extracted.globalSkills, []);
      assert.deepStrictEqual(extracted.sessionSkills, ["security-review"]);
      assert.include(command.message.text, "(this chat)");
    }),
  );

  it.effect("does not leak one chat's skills into another thread", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-session-skill-isolation-" });
      const homeDir = path.join(tempDir, "home");
      const skillPath = path.join(homeDir, ".agents", "skills", "security-review", "SKILL.md");
      yield* fs.makeDirectory(path.dirname(skillPath), { recursive: true });
      yield* fs.writeFileString(skillPath, "---\nname: security-review\n---\n");

      const previousHome = process.env.HOME;
      process.env.HOME = homeDir;
      const configured = ServerSettings.layerTest({
        skills: {
          enabledByThread: { [ThreadId.make("thread-skills")]: ["security-review"] },
        },
      });
      const [selected, unselected] = yield* Effect.all(
        [
          normalizeDispatchCommand(turnStartCommand("selected")),
          normalizeDispatchCommand({
            ...turnStartCommand("unselected"),
            threadId: ThreadId.make("thread-other"),
          }),
        ],
        { concurrency: 1 },
      ).pipe(
        Effect.provide(configured),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousHome === undefined) delete process.env.HOME;
            else process.env.HOME = previousHome;
          }),
        ),
      );

      if (selected.type !== "thread.turn.start" || unselected.type !== "thread.turn.start") return;
      assert.deepStrictEqual(
        extractTrailingEnabledSkillsContext(selected.message.text).sessionSkills,
        ["security-review"],
      );
      assert.equal(unselected.message.text, "unselected");
    }),
  );

  it.effect(
    "deduplicates scopes and enforces the effective context ceiling at the provider boundary",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-session-skill-cap-" });
        const homeDir = path.join(tempDir, "home");
        const allNames = Array.from({ length: 13 }, (_, index) => `skill-${index}`);
        for (const name of allNames) {
          const skillPath = path.join(homeDir, ".agents", "skills", name, "SKILL.md");
          yield* fs.makeDirectory(path.dirname(skillPath), { recursive: true });
          yield* fs.writeFileString(skillPath, `---\nname: ${name}\n---\n`);
        }

        const previousHome = process.env.HOME;
        process.env.HOME = homeDir;
        const command = yield* normalizeDispatchCommand(turnStartCommand("bounded")).pipe(
          Effect.provide(
            ServerSettings.layerTest({
              skills: {
                enabledByDefault: allNames.slice(0, 6),
                enabledByThread: {
                  [ThreadId.make("thread-skills")]: ["skill-0", ...allNames.slice(6)],
                },
              },
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              if (previousHome === undefined) delete process.env.HOME;
              else process.env.HOME = previousHome;
            }),
          ),
        );

        if (command.type !== "thread.turn.start") return;
        const extracted = extractTrailingEnabledSkillsContext(command.message.text);
        assert.deepStrictEqual(extracted.skills, allNames.slice(0, 12));
        assert.deepStrictEqual(extracted.globalSkills, allNames.slice(0, 6));
        assert.deepStrictEqual(extracted.sessionSkills, allNames.slice(6, 12));
        assert.notInclude(command.message.text, "skill-12/SKILL.md");
      }),
  );

  it.effect(
    "attaches defaults before provider-specific dispatch without rewriting model selection",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-default-all-providers-" });
        const homeDir = path.join(tempDir, "home");
        const skillPath = path.join(homeDir, ".agents", "skills", "always-on", "SKILL.md");
        yield* fs.makeDirectory(path.dirname(skillPath), { recursive: true });
        yield* fs.writeFileString(
          skillPath,
          "---\nname: always-on\ndescription: Active everywhere.\n---\n",
        );

        const previousHome = process.env.HOME;
        process.env.HOME = homeDir;
        const command = yield* normalizeDispatchCommand(
          turnStartCommand("same task", ProviderInstanceId.make("agy")),
        ).pipe(
          Effect.provide(ServerSettings.layerTest({ skills: { enabledByDefault: ["always-on"] } })),
          Effect.ensuring(
            Effect.sync(() => {
              if (previousHome === undefined) delete process.env.HOME;
              else process.env.HOME = previousHome;
            }),
          ),
        );

        if (command.type !== "thread.turn.start") return;
        assert.deepStrictEqual(extractTrailingEnabledSkillsContext(command.message.text).skills, [
          "always-on",
        ]);
        assert.include(command.message.text, skillPath);
        assert.equal(command.modelSelection?.instanceId, ProviderInstanceId.make("agy"));
      }),
  );

  it.effect("does not claim that a configured but missing skill was enabled", () =>
    Effect.gen(function* () {
      const { command } = yield* normalizeWithSkillHome("keep going", ["missing-skill"]);
      if (command.type !== "thread.turn.start") return;
      assert.equal(command.message.text, "keep going");
      assert.deepStrictEqual(extractTrailingEnabledSkillsContext(command.message.text).skills, []);
    }),
  );

  it.effect("expands a project skill using the bootstrapping turn's worktree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-normalizer-project-" });
      const worktree = path.join(tempDir, "worktree");
      const skillDir = path.join(worktree, ".agents", "skills", "update-docs");
      yield* fs.makeDirectory(skillDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(skillDir, "SKILL.md"),
        "---\nname: update-docs\ndescription: Refresh the docs.\n---\n\nBody.",
      );

      const base = turnStartCommand("apply $update-docs here");
      const command = yield* normalizeDispatchCommand({
        ...base,
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project-skills"),
            title: "Skills",
            modelSelection: { instanceId: ProviderInstanceId.make("agy"), model: "agy-default" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: worktree,
            createdAt: clientCreatedAt,
          },
        },
      } as ClientOrchestrationCommand);

      if (command.type !== "thread.turn.start") return;
      assert.include(command.message.text, path.join(skillDir, "SKILL.md"));
      assert.include(command.message.text, "Refresh the docs.");
    }),
  );

  it.effect("prefers a project skill over a same-named user skill", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-default-project-skill-" });
      const homeDir = path.join(tempDir, "home");
      const worktree = path.join(tempDir, "worktree");
      const userDir = path.join(homeDir, ".agents", "skills", "security-review");
      const projectDir = path.join(worktree, ".agents", "skills", "security-review");
      yield* fs.makeDirectory(userDir, { recursive: true });
      yield* fs.makeDirectory(projectDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(userDir, "SKILL.md"),
        "---\nname: security-review\ndescription: User version.\n---\n",
      );
      yield* fs.writeFileString(
        path.join(projectDir, "SKILL.md"),
        "---\nname: security-review\ndescription: Project version.\n---\n",
      );

      const previousHome = process.env.HOME;
      process.env.HOME = homeDir;
      const base = turnStartCommand("review this project");
      const command = yield* normalizeDispatchCommand({
        ...base,
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project-default-skill"),
            title: "Default skills",
            modelSelection: { instanceId: ProviderInstanceId.make("agy"), model: "agy-default" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: worktree,
            createdAt: clientCreatedAt,
          },
        },
      } as ClientOrchestrationCommand).pipe(
        Effect.provide(
          ServerSettings.layerTest({
            skills: { enabledByDefault: ["security-review"] },
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousHome === undefined) delete process.env.HOME;
            else process.env.HOME = previousHome;
          }),
        ),
      );

      if (command.type !== "thread.turn.start") return;
      assert.include(command.message.text, path.join(projectDir, "SKILL.md"));
      assert.notInclude(command.message.text, path.join(userDir, "SKILL.md"));
      assert.include(command.message.text, "Project version.");
    }),
  );
});
