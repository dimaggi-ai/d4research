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

import * as ServerConfig from "../config.ts";
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

const turnStartCommand = (text: string): ClientOrchestrationCommand => ({
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
    instanceId: ProviderInstanceId.make("agy"),
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
const normalizeWithSkillHome = Effect.fn(function* (text: string) {
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
});
