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
import { AlmanacConnection, type AlmanacTarget } from "./AlmanacConnection.ts";
import {
  CURRENT_VERSION,
  parseBrowse,
  parseRead,
  parseRecall,
  parseSearch,
} from "./AlmanacText.ts";
import {
  type Call,
  detectProfile,
  fill,
  json,
  KUMBUKA,
  type MemoryProfile,
  parseProfile,
  pick,
  PROFILES,
  prose,
  readRecall,
  readSearch,
  readSource,
  takesPosition,
  type Reply,
  type Vars,
} from "./MemoryProfile.ts";

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

const BROWSE_PAGE = 20;
const WRITE_REPLY_LIMIT = 2000;

/** The first of the variables that is set. Older names still work for an existing install. */
const env = (...names: ReadonlyArray<string>) =>
  names
    .map((name) => Config.String(name))
    .reduce((first, next) => first.pipe(Config.orElse(() => next)))
    .pipe(
      Config.withDefault(""),
      Effect.map((value) => value.trim()),
      Effect.orDie,
    );

const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const fallback = {
    command: yield* env("MEMORY_MCP_COMMAND", "KUMBUKA_MCP_COMMAND", "ALMANAC_MCP_COMMAND"),
    url: yield* env("MEMORY_MCP_URL"),
    // The bearer token is a secret, so it comes from the environment only, never from settings.
    token: yield* env("MEMORY_MCP_TOKEN"),
    provider: yield* env("MEMORY_MCP_PROVIDER"),
    scope: yield* env("MEMORY_MCP_SCOPE"),
  };
  const connection = new AlmanacConnection();

  const fail = (code: AlmanacError["code"], operation: string, cause?: unknown) =>
    new AlmanacError({ code, operation, ...(cause === undefined ? {} : { cause }) });

  /** Where the provider is, and how its tools map onto the memory operations. */
  const choose = Effect.fn("AlmanacService.choose")(function* (operation: string) {
    const almanac = yield* settings.getSettings.pipe(
      Effect.map((value) => value.almanac),
      Effect.mapError((cause) => fail("not_configured", operation, cause)),
    );
    // A value in settings wins over the environment; within one source a url wins over a command.
    const target: AlmanacTarget | null = almanac.url
      ? { url: almanac.url, token: fallback.token }
      : almanac.command
        ? { command: almanac.command }
        : fallback.url
          ? { url: fallback.url, token: fallback.token }
          : fallback.command
            ? { command: fallback.command }
            : null;
    if (!target) return yield* fail("not_configured", operation);
    const scope = almanac.scope || fallback.scope;
    if (almanac.profile) {
      const profile = parseProfile(almanac.profile);
      if (!profile) return yield* fail("malformed", "profile");
      return { target, profile, scope };
    }
    const named = almanac.provider || fallback.provider;
    if (named) {
      const profile = PROFILES.find((candidate) => candidate.name === named);
      if (!profile) return yield* fail("unsupported", `provider ${named}`);
      return { target, profile, scope };
    }
    const tools = yield* Effect.tryPromise({
      try: (signal) => connection.tools(target, signal),
      catch: (cause) => fail("unavailable", operation, cause),
    });
    const profile = detectProfile(tools);
    if (!profile) return yield* fail("unsupported", "this provider; set a provider or a profile");
    return { target, profile, scope };
  });

  // Session ids the providers handed out, by provider and scope. They outlive a reconnect.
  const sessions = new Map<string, string>();
  const sessionKey = (target: AlmanacTarget, scope: Vars[string]) =>
    `${"url" in target ? target.url : target.command}\n${scope ?? ""}`;

  const invoke = Effect.fn("AlmanacService.invoke")(function* (
    target: AlmanacTarget,
    name: string,
    args: Record<string, unknown>,
  ) {
    yield* Effect.annotateCurrentSpan({ "almanac.tool": name });
    const result = yield* Effect.tryPromise({
      try: (signal) => connection.call(target, name, args, signal),
      catch: (cause) => fail("unavailable", name, cause),
    });
    if (result.isError) return yield* fail("rejected", name);
    return result as Reply;
  });

  /** One operation of a JSON provider: the profile's tool, called with its filled arguments. */
  const run = (
    target: AlmanacTarget,
    operation: string,
    call: Call | undefined,
    vars: Vars,
  ): AlmanacEffect<Reply> =>
    call
      ? invoke(
          target,
          call.tool,
          fill(call.args, {
            ...vars,
            session: sessions.get(sessionKey(target, vars.scope)),
          }) as Record<string, unknown>,
        )
      : Effect.fail(fail("unsupported", operation));

  /** The provider and its profile, with the provider's session opened when the profile asks for one. */
  const resolve = Effect.fn("AlmanacService.resolve")(function* (operation: string) {
    const resolved = yield* choose(operation);
    const { target, profile, scope } = resolved;
    const key = sessionKey(target, scope);
    if (!profile.session || sessions.has(key)) return resolved;
    const reply = yield* run(target, "session", profile.session, { scope });
    const id = pick(json(reply), profile.session.id);
    if (typeof id !== "string" || !id) return yield* fail("malformed", "session");
    sessions.set(key, id);
    return resolved;
  });

  const parsed = <A>(name: string, value: A | null): AlmanacEffect<A> =>
    value === null ? Effect.fail(fail("malformed", name)) : Effect.succeed(value);

  const written = (reply: Reply): AlmanacWriteResult => {
    const text = prose(reply) || JSON.stringify(json(reply) ?? "");
    return { result: text.slice(0, WRITE_REPLY_LIMIT) };
  };

  /** Kumbuka replies in bounded plain text. */
  const kumbuka = <A>(
    target: AlmanacTarget,
    name: string,
    args: Record<string, unknown>,
    parse: (reply: string) => A | null,
  ) =>
    invoke(target, name, args).pipe(Effect.flatMap((reply) => parsed(name, parse(prose(reply)))));

  yield* Effect.addFinalizer(() => Effect.sync(() => connection.close()));

  const browseWith = Effect.fn("AlmanacService.browse")(function* (
    { target, profile, scope }: { target: AlmanacTarget; profile: MemoryProfile; scope: string },
    input: AlmanacBrowseInput,
  ) {
    if (profile === KUMBUKA) return yield* kumbuka(target, "kumbuka_browse", input, parseBrowse);
    const call = profile.browse;
    const pageSize = call?.pageSize ?? BROWSE_PAGE;
    const reply = yield* run(target, "browse", call, {
      path: input.path,
      offset: input.offset,
      page: Math.floor(input.offset / pageSize) + 1,
      pageSize,
      scope,
    });
    const listed = yield* parsed("browse", readRecall(reply, call!.memories, false));
    // A provider whose tool takes no position returns everything; the page is cut here.
    const paged = takesPosition(call!);
    const memories = paged
      ? listed.memories
      : listed.memories.slice(input.offset, input.offset + BROWSE_PAGE);
    const more = paged
      ? listed.memories.length >= pageSize
      : input.offset + memories.length < listed.memories.length;
    return {
      categories: [],
      memories,
      passages: [],
      nextOffset: more ? input.offset + memories.length : null,
      total: paged ? null : listed.memories.length,
    } satisfies AlmanacBrowseResult;
  });

  return AlmanacService.of({
    status: Effect.fn("AlmanacService.status")(function* () {
      return yield* Effect.gen(function* () {
        const resolved = yield* resolve("status");
        const { target, profile, scope } = resolved;
        if (profile === KUMBUKA) yield* browseWith(resolved, { path: "", offset: 0 });
        else if (profile.status) yield* run(target, "status", profile.status, { scope });
        // Without a status tool, a session that lists its tools counts as reachable.
        else
          yield* Effect.tryPromise({
            try: (signal) => connection.tools(target, signal),
            catch: (cause) => fail("unavailable", "status", cause),
          });
        return { configured: true, connected: true };
      }).pipe(
        Effect.catchTags({
          AlmanacError: (error) =>
            Effect.succeed({ configured: error.code !== "not_configured", connected: false }),
        }),
      );
    }),
    browse: Effect.fn("AlmanacService.browseAny")(function* (input) {
      return yield* browseWith(yield* resolve("browse"), input);
    }),
    search: Effect.fn("AlmanacService.search")(function* ({ query, limit }) {
      const { target, profile, scope } = yield* resolve("search");
      if (profile === KUMBUKA)
        return yield* kumbuka(target, "kumbuka_search", { query, top_k: limit ?? 10 }, parseSearch);
      const reply = yield* run(target, "search", profile.search, {
        query,
        limit: limit ?? 10,
        scope,
      });
      return yield* parsed("search", readSearch(reply, profile.search!.passages));
    }),
    recall: Effect.fn("AlmanacService.recall")(function* ({ query, limit }) {
      const { target, profile, scope } = yield* resolve("recall");
      if (profile === KUMBUKA)
        return yield* kumbuka(target, "kumbuka_recall", { query, top_k: limit ?? 10 }, parseRecall);
      const reply = yield* run(target, "recall", profile.recall, {
        query,
        limit: limit ?? 10,
        scope,
      });
      return yield* parsed("recall", readRecall(reply, profile.recall!.memories));
    }),
    read: Effect.fn("AlmanacService.read")(function* ({ sourceId, start = 0, maxChars = 8000 }) {
      const { target, profile, scope } = yield* resolve("read");
      if (profile === KUMBUKA)
        return yield* kumbuka(
          target,
          "kumbuka_read",
          { source_id: sourceId, start, max_chars: maxChars },
          parseRead,
        );
      const reply = yield* run(target, "read", profile.read, {
        id: sourceId,
        start,
        maxChars,
        scope,
      });
      return yield* parsed("read", readSource(reply, profile.read!, sourceId, start, maxChars));
    }),
    remember: Effect.fn("AlmanacService.remember")(function* ({ text }) {
      const { target, profile, scope } = yield* resolve("remember");
      if (profile === KUMBUKA)
        return yield* invoke(target, "kumbuka_add", { text }).pipe(Effect.map(written));
      // Providers that name their entries get the first words of the memory.
      const title = text.replace(/\s+/g, " ").trim().slice(0, 60);
      return yield* run(target, "remember", profile.add, { text, title, scope }).pipe(
        Effect.map(written),
      );
    }),
    update: Effect.fn("AlmanacService.update")(function* ({ memoryId, text }) {
      const { target, profile, scope } = yield* resolve("update");
      if (profile !== KUMBUKA)
        return yield* run(target, "update", profile.update, { id: memoryId, text, scope }).pipe(
          Effect.map(written),
        );
      // The update names the version it replaces; the history reply ends with it.
      const version = yield* kumbuka(
        target,
        "kumbuka_history",
        { memory_id: memoryId },
        (reply) => CURRENT_VERSION.exec(reply)?.[1] ?? null,
      );
      return yield* invoke(target, "kumbuka_update", {
        memory_id: memoryId,
        text,
        expected_version: Number(version),
      }).pipe(Effect.map(written));
    }),
    forget: Effect.fn("AlmanacService.forget")(function* ({ memoryId }) {
      const { target, profile, scope } = yield* resolve("forget");
      if (profile === KUMBUKA)
        return yield* invoke(target, "kumbuka_forget", { memory_id: memoryId }).pipe(
          Effect.map(written),
        );
      return yield* run(target, "forget", profile.forget, { id: memoryId, scope }).pipe(
        Effect.map(written),
      );
    }),
  });
});

export const layer = Layer.effect(AlmanacService, make);
