// @effect-diagnostics effectFnOpportunity:warning -- d4research module predating the Effect.fn style rule.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { validateAgentTaskScope } from "../../../d4Agent/D4AgentTaskScope.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import * as Catalog from "../../../d4Agent/PipelineCatalog.ts";

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

function findScenario(settings: ServerSettings, kind: PipelineKind, name: string) {
  return settings[kind].scenarios.find((scenario) => scenario.name === name);
}

const readSettings = (service: ServerSettingsService["Service"]) =>
  service.getSettings.pipe(
    Effect.mapError(
      (error) => new PipelineToolError({ detail: `Could not read pipelines: ${error.message}` }),
    ),
  );

const taskPipeline = Effect.gen(function* () {
  const invocation = yield* Effect.serviceOption(McpInvocationContext);
  const threadId = Option.isSome(invocation) ? invocation.value.thread?.threadId : undefined;
  if (threadId === undefined || !threadId.startsWith("d4-action:")) return null;
  const settings = yield* readSettings(yield* ServerSettingsService);
  const record = yield* validateAgentTaskScope(
    threadId,
    settings.d4Agent,
    undefined,
    settings,
  ).pipe(
    Effect.mapError(
      () =>
        new PipelineToolError({
          detail: "Context operation refused; inspect the selected scope configuration.",
        }),
    ),
  );
  return record?.pipelineId ?? "";
});

const handlers = {
  pipeline_list: ({ kind }) =>
    Effect.gen(function* () {
      const authorizedPipeline = yield* taskPipeline;
      const catalog = yield* Catalog.PipelineCatalog;
      const pipelines = yield* catalog
        .list(kind)
        .pipe(
          Effect.mapError(() => new PipelineToolError({ detail: "Could not read pipelines." })),
        );
      return {
        pipelines: pipelines
          .filter(
            (entry) =>
              authorizedPipeline === null || `${entry.kind}:${entry.name}` === authorizedPipeline,
          )
          .map(({ pipelinePrompt: _prompt, promptFiles, ...entry }) => ({
            ...entry,
            promptFileNames: promptFiles.map((file) => file.name),
          })),
      };
    }).pipe(Effect.provide(Catalog.layer)),
  pipeline_get: ({ kind, name }) =>
    Effect.gen(function* () {
      const authorizedPipeline = yield* taskPipeline;
      const catalog = yield* Catalog.PipelineCatalog;
      if (authorizedPipeline !== null && authorizedPipeline !== `${kind}:${name}`)
        return yield* new PipelineToolError({
          detail: "Context operation refused; inspect the selected scope configuration.",
        });
      const scenario = yield* catalog.get(kind, name).pipe(
        Effect.mapError(
          () =>
            new PipelineToolError({
              detail: `No ${kind} pipeline named "${name}". Call pipeline_list to see available names.`,
            }),
        ),
      );
      return {
        ...scenario,
        editHint:
          "Call pipeline_upsert with this kind and name. Supply the complete pipelinePrompt; omit promptFiles to preserve them.",
      };
    }).pipe(Effect.provide(Catalog.layer)),
  pipeline_upsert: ({ kind, name, pipelinePrompt, promptFiles, makeActive }) =>
    Effect.gen(function* () {
      if ((yield* taskPipeline) !== null)
        return yield* new PipelineToolError({
          detail: "Context operation refused; inspect the selected scope configuration.",
        });
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
      if ((yield* taskPipeline) !== null)
        return yield* new PipelineToolError({
          detail: "Context operation refused; inspect the selected scope configuration.",
        });
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
