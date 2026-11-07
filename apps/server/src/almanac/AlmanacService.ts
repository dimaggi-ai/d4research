import {
  AlmanacError,
  type AlmanacBrowseInput,
  type AlmanacBrowseResult,
  type AlmanacForgetInput,
  type AlmanacReadInput,
  type AlmanacReadResult,
  type AlmanacRecallResult,
  type AlmanacRememberInput,
  type AlmanacSearchInput,
  type AlmanacSearchResult,
  type AlmanacStatus,
  type AlmanacUpdateInput,
  type AlmanacWriteResult,
} from "@d4research/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../serverSettings.ts";
import { AlmanacConnection } from "./AlmanacConnection.ts";
import { parseBrowse, parseRead, parseRecall, parseSearch } from "./AlmanacText.ts";

type AlmanacEffect<A> = Effect.Effect<A, AlmanacError>;

export class AlmanacService extends Context.Service<
  AlmanacService,
  {
    readonly status: () => Effect.Effect<AlmanacStatus>;
    readonly browse: (input: AlmanacBrowseInput) => AlmanacEffect<AlmanacBrowseResult>;
    readonly search: (input: AlmanacSearchInput) => AlmanacEffect<AlmanacSearchResult>;
    readonly recall: (input: AlmanacSearchInput) => AlmanacEffect<AlmanacRecallResult>;
    readonly read: (input: AlmanacReadInput) => AlmanacEffect<AlmanacReadResult>;
    readonly remember: (input: AlmanacRememberInput) => AlmanacEffect<AlmanacWriteResult>;
    readonly update: (input: AlmanacUpdateInput) => AlmanacEffect<AlmanacWriteResult>;
    readonly forget: (input: AlmanacForgetInput) => AlmanacEffect<AlmanacWriteResult>;
  }
>()("d4research/almanac/AlmanacService") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const fallback = yield* Config.String("ALMANAC_MCP_COMMAND").pipe(
    Config.withDefault(""),
    Effect.orDie,
  );
  const connection = new AlmanacConnection();

  const call = Effect.fn("AlmanacService.call")(function* (
    name: string,
    args: Record<string, unknown>,
  ) {
    yield* Effect.annotateCurrentSpan({ "almanac.tool": name });
    const configured = yield* settings.getSettings.pipe(
      Effect.map((value) => value.almanac.command),
      Effect.mapError(
        (cause) => new AlmanacError({ code: "not_configured", operation: name, cause }),
      ),
    );
    const command = configured || fallback.trim();
    if (!command) return yield* new AlmanacError({ code: "not_configured", operation: name });
    const result = yield* Effect.tryPromise({
      try: (signal) => connection.call(command, name, args, signal),
      catch: (cause) => new AlmanacError({ code: "unavailable", operation: name, cause }),
    });
    if (result.isError) return yield* new AlmanacError({ code: "rejected", operation: name });
    const blocks = Array.isArray(result.content) ? result.content : [];
    return blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  });

  const parsed = <A>(name: string, parse: (reply: string) => A | null) =>
    Effect.flatMap((reply: string) => {
      const value = parse(reply);
      return value === null
        ? Effect.fail(new AlmanacError({ code: "malformed", operation: name }))
        : Effect.succeed(value);
    });

  const written = Effect.map((result: string): AlmanacWriteResult => ({ result }));

  yield* Effect.addFinalizer(() => Effect.sync(() => connection.close()));

  const browse = Effect.fn("AlmanacService.browse")(function* (input: AlmanacBrowseInput) {
    return yield* call("memory_browse", input).pipe(parsed("memory_browse", parseBrowse));
  });

  return AlmanacService.of({
    status: Effect.fn("AlmanacService.status")(function* () {
      return yield* browse({ path: "", offset: 0 }).pipe(
        Effect.as({ configured: true, connected: true }),
        Effect.catchTags({
          AlmanacError: (error) =>
            Effect.succeed({ configured: error.code !== "not_configured", connected: false }),
        }),
      );
    }),
    browse,
    search: Effect.fn("AlmanacService.search")(function* ({ query, limit }) {
      return yield* call("knowledge_search", { query, top_k: limit ?? 10 }).pipe(
        parsed("knowledge_search", parseSearch),
      );
    }),
    recall: Effect.fn("AlmanacService.recall")(function* ({ query, limit }) {
      return yield* call("memory_recall", { query, top_k: limit ?? 10 }).pipe(
        parsed("memory_recall", parseRecall),
      );
    }),
    read: Effect.fn("AlmanacService.read")(function* ({ sourceId, start, maxChars }) {
      return yield* call("knowledge_read", {
        source_id: sourceId,
        start: start ?? 0,
        max_chars: maxChars ?? 8000,
      }).pipe(parsed("knowledge_read", parseRead));
    }),
    remember: Effect.fn("AlmanacService.remember")(function* ({ text }) {
      return yield* call("memory_add", { text }).pipe(written);
    }),
    update: Effect.fn("AlmanacService.update")(function* ({ memoryId, text }) {
      return yield* call("memory_update", { memory_id: memoryId, text }).pipe(written);
    }),
    forget: Effect.fn("AlmanacService.forget")(function* ({ memoryId }) {
      return yield* call("memory_forget", { memory_id: memoryId }).pipe(written);
    }),
  });
});

export const layer = Layer.effect(AlmanacService, make);
