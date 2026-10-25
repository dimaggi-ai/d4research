import { sha256Hex } from "@d4research/shared/hash";
import type { ResearchScenario } from "@d4research/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerSettingsService } from "../serverSettings.ts";

export type PipelineKind = "dev" | "research";
export type PipelineDefinition = ResearchScenario & {
  readonly kind: PipelineKind;
  readonly active: boolean;
  readonly trigger: string;
};
export class PipelineCatalogError extends Schema.TaggedError<PipelineCatalogError>()(
  "PipelineCatalogError",
  { reason: Schema.Literals(["settings", "missing"]) },
) {}

export class PipelineCatalog extends Context.Service<
  PipelineCatalog,
  {
    readonly list: (
      kind?: PipelineKind,
    ) => Effect.Effect<ReadonlyArray<PipelineDefinition>, PipelineCatalogError>;
    readonly get: (
      kind: PipelineKind,
      name: string,
    ) => Effect.Effect<PipelineDefinition, PipelineCatalogError>;
  }
>()("d4research/d4Agent/PipelineCatalog") {}

const make = Effect.gen(function* () {
  const service = yield* ServerSettingsService;
  const list = Effect.fn("PipelineCatalog.list")(function* (kind?: PipelineKind) {
    const settings = yield* service.getSettings.pipe(
      Effect.mapError(() => new PipelineCatalogError({ reason: "settings" })),
    );
    const kinds: ReadonlyArray<PipelineKind> = kind ? [kind] : ["dev", "research"];
    return kinds.flatMap((entry) =>
      settings[entry].scenarios.map((scenario) => ({
        ...scenario,
        kind: entry,
        active: settings[entry].activeScenario === scenario.name,
        trigger: `!${entry}:${scenario.name}`,
      })),
    );
  });
  const get = Effect.fn("PipelineCatalog.get")(function* (kind: PipelineKind, name: string) {
    const scenario = (yield* list(kind)).find((entry) => entry.name === name);
    if (scenario === undefined) return yield* new PipelineCatalogError({ reason: "missing" });
    return scenario;
  });
  return PipelineCatalog.of({ list, get });
});
export const layer = Layer.effect(PipelineCatalog, make);

export const pipelineFingerprint = (
  definition: ResearchScenario & { readonly kind: PipelineKind },
) =>
  sha256Hex(
    JSON.stringify([
      definition.kind,
      definition.name,
      definition.pipelinePrompt,
      definition.promptFiles,
    ]),
  );
