// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Crypto, Effect, FileSystem, Queue, Schema, Stream } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";
import type { MuseSettings, RuntimeMode } from "@d4research/contracts";
import { resolveSpawnCommand } from "@d4research/shared/shell";
import { toolGuardEnvironment } from "../toolGuardRuntime.ts";
import {
  makeMspConnection,
  MspTransportError,
  MspRpcError,
  type MspConnectionOptions,
} from "./MspConnection.ts";
import * as Msp from "./MspProtocol.ts";
import { approvalModeForRuntimeMode } from "./museApprovalMode.ts";

export interface MuseMspRuntimeOptions {
  readonly settings: MuseSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cwd: string;
  readonly runtimeMode?: RuntimeMode;
  /**
   * Read-only host posture for plan mode. Sandbox posture is fixed per
   * `muse serve` process, so a plan host spawns with
   * `--disable-write --disable-shell` and can never regain write access.
   */
  readonly planMode?: boolean;
  readonly clientInfo: { readonly name: string; readonly version: string };
  readonly onEvent?: MspConnectionOptions["onNotification"];
  readonly onServerRequest?: MspConnectionOptions["onServerRequest"];
  readonly logger?: MspConnectionOptions["logger"];
  readonly onError?: (error: MspRpcError) => Effect.Effect<void>;
  readonly onWarning?: (message: string) => Effect.Effect<void>;
}
export const makeMuseMspRuntime = Effect.fn("makeMuseMspRuntime")(function* (
  options: MuseMspRuntimeOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const stdin = yield* Queue.unbounded<Uint8Array>();
  const temp = NodePath.join(NodeOS.tmpdir(), "t3-muse");
  yield* fs.makeDirectory(temp, { recursive: true });
  const environment = {
    ...toolGuardEnvironment(options.environment, options.runtimeMode ?? "approval-required"),
    TMPDIR: temp,
  };
  const args = [
    "serve",
    "--trust-workspace",
    ...(options.planMode === true ? ["--disable-write", "--disable-shell"] : []),
    ...(options.settings.disableSandbox ? ["--disable-sandbox"] : []),
    ...(options.settings.sandboxNetwork
      ? ["--sandbox-network", options.settings.sandboxNetwork]
      : []),
  ];
  const resolved = yield* resolveSpawnCommand(options.settings.binaryPath || "muse", args, {
    env: environment,
  });
  const handle = yield* options.spawner.spawn(
    ChildProcess.make(resolved.command, resolved.args, {
      cwd: options.cwd,
      env: environment,
      shell: resolved.shell,
      stdin: Stream.fromQueue(stdin),
    }),
  );
  let stderr = "";
  const connection = yield* makeMspConnection(handle, {
    stdin,
    onNotification: options.onEvent ?? (() => Effect.void),
    onServerRequest: options.onServerRequest ?? (() => Effect.succeed({})),
    onStderr: (text) =>
      Effect.sync(() => {
        stderr = `${stderr}${text}`.slice(-8000);
      }),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const decode = <S extends Schema.Top & { readonly DecodingServices: never }>(
    schema: S,
    value: unknown,
  ) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError((error) => new MspTransportError({ message: String(error) })),
    );
  const request = (method: Msp.MspMethod, params: unknown) =>
    connection
      .request(method, params)
      .pipe(
        Effect.tapError((error) =>
          error._tag === "MspRpcError" ? (options.onError?.(error) ?? Effect.void) : Effect.void,
        ),
      );
  const initializeResult = yield* request("initialize", {
    clientInfo: options.clientInfo,
    capabilities: { userInputDialogs: true, requestedCapabilities: ["sessionMcp"] },
  }).pipe(Effect.flatMap((value) => decode(Msp.InitializeResult, value)));
  const grantedCapabilities: ReadonlyArray<string> = initializeResult.grantedCapabilities;
  const sessionMcpGranted = grantedCapabilities.includes("sessionMcp");
  yield* connection.notify("initialized", {});
  const command = Effect.fn("MuseMspRuntime.command")(function* (
    method: Msp.MspMethod,
    params: object,
  ) {
    return yield* request(method, { ...params, commandId: yield* crypto.randomUUIDv7 });
  });
  const ceiling = (error: { readonly data?: Msp.ErrorData }) =>
    error.data?.kind === "commandRejected" && error.data.reason === "approval_mode_ceiling";
  const warning = () =>
    options.onWarning?.("Muse limited the approval mode to the host default") ?? Effect.void;
  const sessionMcpWarning = () =>
    options.onWarning?.(
      "Muse host did not grant the sessionMcp capability; d4research MCP tools are unavailable in this session",
    ) ?? Effect.void;
  const mode = approvalModeForRuntimeMode(
    options.runtimeMode ?? "approval-required",
    options.settings.approvalMode,
  );
  return {
    startSession: Effect.fn("MuseMspRuntime.startSession")(function* (
      input: {
        approvalMode?: Msp.ApprovalMode | null;
        modelId?: string;
        config?: Msp.SessionConfig;
      } = {},
    ) {
      if (input.config !== undefined && !sessionMcpGranted) yield* sessionMcpWarning();
      const params = {
        workspaceRoot: options.cwd,
        approvalMode: input.approvalMode === undefined ? mode : input.approvalMode,
        ...(input.modelId && input.modelId !== "default" ? { modelId: input.modelId } : {}),
        ...(input.config !== undefined && sessionMcpGranted ? { config: input.config } : {}),
      };
      const result = yield* command("session/start", params).pipe(
        Effect.catchTag("MspRpcError", (error) =>
          ceiling(error)
            ? warning().pipe(
                Effect.andThen(command("session/start", { ...params, approvalMode: null })),
              )
            : Effect.fail(error),
        ),
      );
      return yield* decode(Msp.SessionStartResult, result);
    }),
    resumeSession: Effect.fn("MuseMspRuntime.resumeSession")(function* (input: {
      sessionId: string;
      cursor?: string;
      config?: Msp.SessionConfig;
    }) {
      const { config, ...withoutConfig } = input;
      if (config !== undefined && !sessionMcpGranted) yield* sessionMcpWarning();
      const result = yield* command("session/resume", {
        ...withoutConfig,
        ...(config !== undefined && sessionMcpGranted ? { config } : {}),
        excludeItems: true,
      }).pipe(Effect.flatMap((value) => decode(Msp.SessionResumeResult, value)));
      yield* command("session/setApprovalMode", { sessionId: input.sessionId, mode }).pipe(
        Effect.catchTag("MspRpcError", (error) =>
          ceiling(error) ? warning() : Effect.fail(error),
        ),
      );
      return result;
    }),
    startTurn: (input: {
      commandId: string;
      sessionId: string;
      input: ReadonlyArray<
        | { type: "text"; text: string }
        | { type: "image"; base64Data: string; mediaType: string; width?: number; height?: number }
      >;
      reasoningEffort?: Msp.ReasoningEffort;
    }) =>
      request("turn/start", input).pipe(
        Effect.flatMap((value) => decode(Msp.TurnStartResult, value)),
      ),
    interrupt: (sessionId: string, turnId?: string) =>
      command("turn/interrupt", { sessionId, ...(turnId ? { turnId } : {}) }),
    compact: (sessionId: string) =>
      command("session/compact", { sessionId }).pipe(
        Effect.flatMap((value) => decode(Schema.Struct({ status: Schema.String }), value)),
      ),
    setModel: (sessionId: string, modelId: string) =>
      command("session/setModel", { sessionId, model: { modelId } }),
    readOutput: (input: { sessionId: string; itemId: string; outputRef: string }) =>
      request("item/readOutput", input).pipe(
        Effect.flatMap((value) => decode(Msp.ItemReadOutputResult, value)),
      ),
    setReasoningEffort: (sessionId: string, reasoningEffort: Msp.ReasoningEffort) =>
      command("session/setReasoningEffort", { sessionId, reasoningEffort }),
    decideApproval: (
      sessionId: string,
      params: {
        approvalId: string;
        choiceId: string;
        requirementId: Msp.ApprovalRequirementRef;
        feedback?: string;
      },
    ) => command("approval/decide", { sessionId, ...params }),
    answerUserInput: (
      sessionId: string,
      userInputId: string,
      answers: ReadonlyArray<{
        questionId: string;
        selectedLabel?: string;
        selectedLabels?: ReadonlyArray<string>;
      }>,
    ) => command("userInput/answer", { sessionId, userInputId, answers }),
    cancelUserInput: (sessionId: string, userInputId: string, reason: string) =>
      command("userInput/cancel", { sessionId, userInputId, reason }),
    listModels: () =>
      request("model/list", {}).pipe(Effect.flatMap((value) => decode(Msp.ModelListResult, value))),
    grantedCapabilities,
    museHome: initializeResult.museHome,
    exitCode: connection.exitCode,
    ended: connection.ended,
    stderr: () => stderr,
    stop: connection.close,
  };
});
export type MuseMspRuntime = Effect.Success<ReturnType<typeof makeMuseMspRuntime>>;
