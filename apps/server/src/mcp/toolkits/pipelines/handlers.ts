import * as Effect from "effect/Effect";

import type { ResearchScenario, ServerSettings } from "@d4research/contracts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { PipelinesToolkit, PipelineToolError } from "./tools.ts";

type PipelineKind = "dev" | "research";

function scenarioOutput(settings: ServerSettings, kind: PipelineKind, scenario: ResearchScenario) {
  return {
    kind,
    ...scenario,
    active: settings[kind].activeScenario === scenario.name,
    trigger: `!${kind}:${scenario.name}`,
  };
}

function scenarioSummary(settings: ServerSettings, kind: PipelineKind, scenario: ResearchScenario) {
  return {
    kind,
    name: scenario.name,
    active: settings[kind].activeScenario === scenario.name,
    trigger: `!${kind}:${scenario.name}`,
    promptFileNames: scenario.promptFiles.map((file) => file.name),
  };
}

function findScenario(settings: ServerSettings, kind: PipelineKind, name: string) {
  return settings[kind].scenarios.find((scenario) => scenario.name === name);
}

const readSettings = (service: ServerSettingsService["Service"]) =>
  service.getSettings.pipe(
    Effect.mapError(
      (error) => new PipelineToolError({ detail: `Could not read pipelines: ${error.message}` }),
    ),
  );

const handlers = {
  pipeline_list: ({ kind }) =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsService;
      const settings = yield* readSettings(service);
      const kinds: ReadonlyArray<PipelineKind> = kind ? [kind] : ["dev", "research"];
      return {
        pipelines: kinds.flatMap((entry) =>
          settings[entry].scenarios.map((scenario) => scenarioSummary(settings, entry, scenario)),
        ),
      };
    }),
  pipeline_get: ({ kind, name }) =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsService;
      const settings = yield* readSettings(service);
      const scenario = findScenario(settings, kind, name);
      if (!scenario) {
        return yield* new PipelineToolError({
          detail: `No ${kind} pipeline named "${name}". Call pipeline_list to see available names.`,
        });
      }
      return {
        ...scenarioOutput(settings, kind, scenario),
        editHint:
          "Call pipeline_upsert with this kind and name. Supply the complete pipelinePrompt; omit promptFiles to preserve them.",
      };
    }),
  pipeline_upsert: ({ kind, name, pipelinePrompt, promptFiles, makeActive }) =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsService;
      const scenarioPatch = {
        name,
        pipelinePrompt,
        ...(promptFiles === undefined ? {} : { promptFiles }),
      };
      const next = yield* service
        .updateSettings({
          [kind]: {
            upsertScenario: scenarioPatch,
            ...(makeActive ? { activeScenario: name } : {}),
          },
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new PipelineToolError({ detail: `Could not save pipeline: ${error.message}` }),
          ),
        );
      const scenario = findScenario(next, kind, name);
      if (!scenario) {
        return yield* new PipelineToolError({
          detail: `Pipeline "${name}" was saved but could not be read back.`,
        });
      }
      return scenarioOutput(next, kind, scenario);
    }),
  pipeline_delete: ({ kind, name }) =>
    Effect.gen(function* () {
      const service = yield* ServerSettingsService;
      const current = yield* readSettings(service);
      if (!findScenario(current, kind, name)) {
        return yield* new PipelineToolError({
          detail: `No ${kind} pipeline named "${name}". Nothing was deleted.`,
        });
      }
      yield* service
        .updateSettings({
          [kind]: {
            removeScenario: name,
          },
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new PipelineToolError({ detail: `Could not delete pipeline: ${error.message}` }),
          ),
        );
      return { kind, name, deleted: true };
    }),
} satisfies Parameters<typeof PipelinesToolkit.toLayer>[0];

export const PipelinesToolkitHandlersLive = PipelinesToolkit.toLayer(handlers);
