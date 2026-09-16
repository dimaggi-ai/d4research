// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import { Crypto, Deferred, Effect, FileSystem, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { type MuseSettings, type ModelSelection, TextGenerationError } from "@d4research/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@d4research/shared/git";
import { extractJsonObject } from "@d4research/shared/schemaJson";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import { makeMuseMspRuntime } from "../provider/msp/MspSessionRuntime.ts";
import { decodeMspNotification } from "../provider/msp/MspProtocol.ts";
import { mapTurnError } from "../provider/msp/museRuntimeEvents.ts";

const isTextGenerationError = Schema.is(TextGenerationError);
export const MUSE_TIMEOUT_MS = 180_000;
export const makeMuseTextGeneration = Effect.fn("makeMuseTextGeneration")(function* (
  settings: MuseSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options?: { readonly makeRuntime?: typeof makeMuseMspRuntime },
) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  // Title and commit-message sessions would otherwise linger in `muse`
  // history. `--no-session-log` is not an option: the ephemeral host seals
  // the approval ceiling and emits nothing after `turn/start` is accepted,
  // so the turn text never arrives. Instead remove exactly the durable log
  // Muse returned, and only when it sits under Muse's own session store.
  const removeSessionLog = (museHome: string, sessionId: string, sessionPath: string) =>
    Effect.gen(function* () {
      if (!sessionPath) return;
      const root = NodePath.resolve(museHome, "sessions");
      const target = NodePath.resolve(sessionPath);
      if (target === root || !target.startsWith(`${root}${NodePath.sep}`)) return;
      if (NodePath.basename(target) !== "session.jsonl") return;
      if (NodePath.basename(NodePath.dirname(target)) !== sessionId) return;
      const info = yield* fs.stat(target).pipe(Effect.orElseSucceed(() => undefined));
      if (info?.type !== "File") return;
      yield* fs.remove(target).pipe(Effect.orElseSucceed(() => undefined));
    }).pipe(Effect.orElseSucceed(() => undefined));
  const runMuseJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void, TextGenerationError>();
      const commandId = yield* crypto.randomUUIDv7;
      const items = new Set<string>();
      let output = "";
      const runtime = yield* (options?.makeRuntime ?? makeMuseMspRuntime)({
        settings,
        environment,
        spawner,
        cwd,
        clientInfo: { name: "t3_code", version: "0.0.1" },
        onEvent: (method, params) =>
          Effect.gen(function* () {
            const event = yield* Effect.try(() => decodeMspNotification(method, params)).pipe(
              Effect.orElseSucceed(() => undefined),
            );
            if (!event) return;
            if (
              event.method === "item/started" &&
              event.params.item.kind === "agentMessage" &&
              event.params.item.turnId === commandId
            )
              items.add(event.params.item.itemId);
            if (
              event.method === "item/delta" &&
              items.has(event.params.itemId) &&
              (!event.params.field || event.params.field === "text")
            )
              output += event.params.delta;
            if (event.method === "turn/completed" && event.params.turnId === commandId) {
              if (event.params.terminal === "completed")
                yield* Deferred.succeed(completed, undefined);
              else
                yield* Deferred.fail(
                  completed,
                  new TextGenerationError({ operation, detail: mapTurnError(event.params.error) }),
                );
            }
          }),
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(FileSystem.FileSystem, fs),
      );
      const session = yield* runtime.startSession({
        approvalMode: "denyUnmatched",
        modelId: modelSelection.model,
      });
      const started = {
        sessionId: session.session.sessionId,
        path: session.session.path,
        home: runtime.museHome,
      };
      yield* runtime.startTurn({
        commandId,
        sessionId: started.sessionId,
        input: [{ type: "text", text: prompt }],
      });
      // Stop the host before deleting: a live host can flush its log buffers
      // back to disk after the removal.
      yield* Effect.raceFirst(Deferred.await(completed), runtime.ended).pipe(
        Effect.ensuring(
          runtime.stop
            .pipe(Effect.ignore)
            .pipe(Effect.andThen(removeSessionLog(started.home, started.sessionId, started.path))),
        ),
      );
      if (!output.trim())
        return yield* new TextGenerationError({ operation, detail: "Muse returned empty output." });
      return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))(
        extractJsonObject(output.trim()),
      );
    }).pipe(
      Effect.timeout(MUSE_TIMEOUT_MS),
      Effect.scoped,
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({ operation, detail: "Muse text generation failed.", cause }),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("MuseTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runMuseJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("MuseTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runMuseJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("MuseTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runMuseJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("MuseTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });

      const generated = yield* runMuseJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
