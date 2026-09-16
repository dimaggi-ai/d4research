// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { Effect, Schema } from "effect";
import { MuseSettings } from "@d4research/contracts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";

const decodeMuseSettings = Schema.decodeUnknownEffect(MuseSettings);
export const sourceRange = {
  first: { id: "r", sequence: 1 },
  last: { id: "r", sequence: 1 },
  stream: { id: "s", kind: "session" },
};
export const view = { sessionId: "mock-muse-session", viewCursor: "cursor-1", sourceRange };
export const approval = {
  ...view,
  approvalId: "approval",
  currentRequirementId: { approvalId: "approval", sourceIndex: 0 },
  itemId: "item",
  taskId: "task",
  toolCallId: "call",
  toolName: "shell",
  turnId: "turn",
  rawArgs: "{}",
  protectedWrite: false,
  judgeEscalated: false,
  subject: { kind: "shell", command: "pwd" },
  availableChoices: [
    { choiceId: "once", decision: "approved", label: "Allow", scope: "once" },
    {
      choiceId: "session",
      decision: "approvedForSession",
      label: "Allow session",
      scope: "session",
    },
    {
      choiceId: "always",
      decision: "approvedPolicyAmendment",
      label: "Always",
      scope: "localPersistent",
      rulePreview: "Allow shell",
    },
    { choiceId: "deny", decision: "denied", label: "Deny", scope: "once", acceptsFeedback: true },
  ],
};
export const makeMockMuse = Effect.fn("makeMockMuse")(function* (
  env: Record<string, string> = {},
  options: { readonly argvLog?: boolean } = {},
) {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "muse-mock-test-"))),
    (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
  const logPath = NodePath.join(directory, "requests.jsonl");
  const argvPath = NodePath.join(directory, "argv.log");
  const binaryPath = writeFakeCli({
    directory,
    name: "fake-muse",
    env: { ...env, T3_MSP_REQUEST_LOG_PATH: logPath },
    source: execScriptSource({
      scriptPath: NodeURL.fileURLToPath(
        new URL("../../../scripts/msp-mock-host.ts", import.meta.url),
      ),
      ...(options.argvLog === true ? { argvLogPath: argvPath } : {}),
    }),
  });
  const decodeRequest = Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        method: Schema.optionalKey(Schema.String),
        params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      }),
    ),
  );
  return {
    directory,
    binaryPath,
    settings: yield* decodeMuseSettings({ binaryPath, enabled: true }),
    readRequests: () =>
      Effect.promise(() => NodeFSP.readFile(logPath, "utf8")).pipe(
        Effect.flatMap((text) =>
          Effect.forEach(text.trim().split("\n"), (line) => decodeRequest(line)),
        ),
      ),
    readArgv: () =>
      Effect.promise(() => NodeFSP.readFile(argvPath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
        Effect.map((text: string) =>
          text
            .trim()
            .split("\n")
            .filter((line: string) => line.length > 0)
            .map((line: string) => line.split("\t")),
        ),
      ),
  };
});
