import * as Path from "effect/Path";
import { HttpClient } from "effect/http";
import * as ServerConfig from "./config.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ThreadId } from "@d4research/contracts";
import type { HandoffSettings, MekoReadInput, MekoReceipt } from "@d4research/contracts/settings";

import { ServerSettingsService } from "./serverSettings.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import { MekoHandoffClient } from "./mekoHandoff.ts";
import { makeConfiguredMemoryConnector } from "./mcp/toolkits/memory/localConnector.ts";

type ReadInput = typeof MekoReadInput.Type;
type SaveInput = { text: string; project?: string | undefined; threadId?: string | undefined };
const sameConnection = (left: HandoffSettings["meko"], right: HandoffSettings["meko"]) =>
  left.url === right.url &&
  left.tokenEnv === right.tokenEnv &&
  left.datapackId === right.datapackId &&
  left.agentId === right.agentId;

export class HandoffMemory extends Context.Service<
  HandoffMemory,
  {
    readonly status: (threadId?: string) => Effect.Effect<ReturnType<MekoHandoffClient["status"]>>;
    readonly check: Effect.Effect<MekoReceipt>;
    readonly read: (
      input: ReadInput,
      callerThreadId?: string,
    ) => Effect.Effect<{ receipt: MekoReceipt; text?: string }>;
    readonly save: (input: SaveInput) => Effect.Effect<{ ok: boolean; receipt?: MekoReceipt }>;
    readonly schedule: (
      input: SaveInput,
      onFailure?: (receipt: MekoReceipt) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
  }
>()("d4research/handoffMemory") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const scope = yield* Scope.Scope;
  const client = new MekoHandoffClient();
  const localServices = yield* Effect.context<
    Path.Path | HttpClient.HttpClient | ServerConfig.ServerConfig | ServerSettingsService
  >();
  const changes = yield* settingsService.subscribeChanges;
  yield* Stream.runForEach(changes, () => Effect.sync(() => client.cancel())).pipe(
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => client.cancel()));
  const settings = settingsService.getSettings.pipe(Effect.option);
  // @effect-diagnostics globalDate:off -- Receipt timestamps are diagnostic wall-clock metadata.
  const refused = (message: string): MekoReceipt => ({
    status: "ERROR_CONFIGURATION",
    message,
    timestamp: new Date().toISOString(),
  });
  const disabled = () => refused("Meko handoffs are disabled or unavailable.");
  const config = Effect.gen(function* () {
    const current = yield* settings;
    return current._tag === "Some" && current.value.handoff.memoryBackend === "meko"
      ? current.value.handoff.meko
      : undefined;
  });
  const status = Effect.fn(function* (threadId?: string) {
    const selected = yield* config;
    return selected
      ? client.status(selected, threadId)
      : { configured: false, recent: [], message: disabled().message };
  });
  const check = Effect.gen(function* () {
    const selected = yield* config;
    return selected ? yield* Effect.promise(() => client.check(selected)) : disabled();
  });
  const read = Effect.fn(function* (input: ReadInput, callerThreadId?: string) {
    const selected = yield* config;
    if (!selected) return { receipt: disabled() };
    if (callerThreadId !== undefined && input.threadId !== callerThreadId)
      return { receipt: refused("Handoff recall requires the current thread.") };
    const thread = yield* projections
      .getThreadRecords(ThreadId.make(input.threadId), [])
      .pipe(Effect.option);
    if (thread._tag === "None" || String(thread.value.thread.projectId) !== input.project)
      return { receipt: refused("Handoff recall requires the matching project and thread.") };
    const latest = yield* config;
    if (!latest || !sameConnection(latest, selected)) return { receipt: disabled() };
    return yield* Effect.promise(() => client.read(latest, input));
  });
  const save = Effect.fn(function* (input: SaveInput) {
    const current = yield* settings;
    if (current._tag === "None" || current.value.handoff.memoryBackend === "none")
      return { ok: false };
    if (current.value.handoff.memoryBackend === "meko") {
      const thread = input.threadId
        ? yield* projections.getThreadRecords(ThreadId.make(input.threadId), []).pipe(Effect.option)
        : undefined;
      if (!thread || thread._tag === "None")
        return { ok: false, receipt: refused("Handoff storage requires an existing thread.") };
      const latest = yield* config;
      if (!latest || !sameConnection(latest, current.value.handoff.meko))
        return { ok: false, receipt: disabled() };
      const receipt = yield* Effect.promise(() =>
        client.save(latest, {
          text: input.text,
          threadId: input.threadId!,
          project: String(thread.value.thread.projectId),
        }),
      );
      return { ok: receipt.status === "SUCCESS_WITH_EVIDENCE", receipt };
    }
    if (!current.value.memory.localEnabled) return { ok: false };
    const connector = yield* makeConfiguredMemoryConnector().pipe(
      Effect.provide(localServices),
      Effect.option,
    );
    if (connector._tag === "None") return { ok: false };
    return yield* connector.value
      .add(input.text, "t3research-provider-handoff", input.project)
      .pipe(Effect.catch(() => Effect.succeed({ ok: false })));
  });
  return HandoffMemory.of({
    status,
    check,
    read,
    save,
    schedule: (input, onFailure) =>
      Effect.gen(function* () {
        if (!(yield* config)) return;
        const result = yield* save(input);
        if ("receipt" in result && result.receipt && !result.ok && onFailure)
          yield* onFailure(result.receipt);
      }).pipe(Effect.forkIn(scope), Effect.asVoid),
  });
});
export const layer = Layer.effect(HandoffMemory, make);
