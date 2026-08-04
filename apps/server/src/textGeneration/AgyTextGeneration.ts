import { type AgySettings, TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";
import { spawnAndCollect } from "../provider/providerSnapshot.ts";

const AgyJsonEnvelope = Schema.Struct({
  status: Schema.String,
  response: Schema.Unknown,
});
const decodeEnvelope = Schema.decodeUnknownSync(Schema.fromJsonString(AgyJsonEnvelope));
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const isTextGenerationError = Schema.is(TextGenerationError);

export const makeAgyTextGeneration = Effect.fn("makeAgyTextGeneration")(function* (
  settings: AgySettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runAgyJson = <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchemaJson: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const args = [
        ...tokenizeCliArgs(settings.launchArgs),
        "--print",
        input.prompt,
        "--output-format",
        "json",
        "--json-schema",
        encodeUnknownJson(toJsonSchemaObject(input.outputSchemaJson)),
        "--print-timeout",
        "5m",
        "--model",
        input.modelSelection.model,
        "--sandbox",
      ];
      const command = settings.binaryPath || "agy";
      const resolved = yield* resolveSpawnCommand(command, args, { env: environment });
      const result = yield* spawnAndCollect(
        command,
        ChildProcess.make(resolved.command, resolved.args, {
          cwd: input.cwd,
          env: environment,
          shell: resolved.shell,
        }),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      if (result.code !== 0) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: result.stderr.trim() || `Antigravity exited with code ${result.code}.`,
        });
      }
      return result.stdout;
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: "Antigravity text generation failed.",
              cause,
            }),
      ),
      Effect.flatMap((raw) =>
        Effect.try({
          try: () => decodeEnvelope(raw),
          catch: (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Antigravity returned invalid JSON output.",
              cause,
            }),
        }),
      ),
      Effect.flatMap((envelope) => {
        if (envelope.status !== "SUCCESS") {
          return Effect.fail(
            new TextGenerationError({
              operation: input.operation,
              detail: `Antigravity returned status '${envelope.status}'.`,
            }),
          );
        }
        const response =
          typeof envelope.response === "string"
            ? envelope.response
            : JSON.stringify(envelope.response);
        return Schema.decodeEffect(Schema.fromJsonString(input.outputSchemaJson))(
          extractJsonObject(response),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Antigravity returned invalid structured output.",
                cause,
              }),
          ),
        );
      }),
    );

  return {
    generateCommitMessage: (input) => {
      const { prompt, outputSchema } = buildCommitMessagePrompt(input);
      return runAgyJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      }).pipe(
        Effect.map((generated) => ({
          subject: sanitizeCommitSubject(generated.subject),
          body: generated.body.trim(),
          ...("branch" in generated && typeof generated.branch === "string"
            ? { branch: sanitizeFeatureBranchName(generated.branch) }
            : {}),
        })),
      );
    },
    generatePrContent: (input) => {
      const { prompt, outputSchema } = buildPrContentPrompt(input);
      return runAgyJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      }).pipe(
        Effect.map((generated) => ({
          title: sanitizePrTitle(generated.title),
          body: generated.body.trim(),
        })),
      );
    },
    generateBranchName: (input) => {
      const { prompt, outputSchema } = buildBranchNamePrompt(input);
      return runAgyJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      }).pipe(Effect.map((generated) => ({ branch: sanitizeBranchFragment(generated.branch) })));
    },
    generateThreadTitle: (input) => {
      const { prompt, outputSchema } = buildThreadTitlePrompt(input);
      return runAgyJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      }).pipe(
        Effect.map(
          (generated) =>
            ({
              title: sanitizeThreadTitle(generated.title),
            }) satisfies TextGeneration.ThreadTitleGenerationResult,
        ),
      );
    },
  } satisfies TextGeneration.TextGeneration["Service"];
});
