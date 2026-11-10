/**
 * Reads second-brain knowledge from Kumbuka instead of the vault files.
 *
 * Each context has its own client token, which can read that context's namespace
 * and the shared one, so the store enforces the boundary and this module cannot
 * widen it. Paths are the vault paths the pages were imported under.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Token files are read once per context at the filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Token file names are joined at the filesystem boundary.
import * as NodePath from "node:path";
import {
  type BrainSearchInput,
  type BrainSearchResponse,
  type BrainSearchResult,
  type D4BrainContext,
  SecondBrainError,
} from "@d4research/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const URI_PREFIX = "obsidian:";
const MAX_BODY = 4 * 1024 * 1024;
const REVISIONS_KEPT = 200;

const Hit = Schema.Struct({
  source_id: Schema.String,
  revision_id: Schema.String,
  start_offset: Schema.Int,
  end_offset: Schema.Int,
  path: Schema.String,
  text: Schema.String,
  score: Schema.Number,
  rerank_score: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
const SearchReply = Schema.Struct({ results: Schema.Array(Hit) });
const Source = Schema.Struct({
  uri: Schema.String,
  content: Schema.String,
  content_hash: Schema.String,
});
const SourcePage = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: Schema.String, uri: Schema.String })),
  next_cursor: Schema.NullOr(Schema.String),
});
const isBrainError = Schema.is(SecondBrainError);
const decodeSearch = Schema.decodeUnknownSync(SearchReply);
const decodeSource = Schema.decodeUnknownSync(Source);
const decodeSourcePage = Schema.decodeUnknownSync(SourcePage);

type BrainEffect<A> = Effect.Effect<A, SecondBrainError>;
export type KumbukaPage = { content: string; hash: string };

export class KumbukaBrain extends Context.Service<
  KumbukaBrain,
  {
    /** False when no API address is set; callers then read the vault. */
    readonly enabled: boolean;
    readonly search: (
      context: D4BrainContext,
      input: BrainSearchInput,
    ) => BrainEffect<BrainSearchResponse>;
    readonly page: (context: D4BrainContext, path: string) => BrainEffect<KumbukaPage>;
  }
>()("d4research/second-brain/KumbukaBrain") {}

const unavailable = () => new SecondBrainError({ code: "unavailable" });
const newlines = (text: string) => text.split("\n").length - 1;

export const make = (options: { readonly url: string; readonly tokens: string }) => {
  const tokens = new Map<D4BrainContext, string>();
  const revisions = new Map<string, typeof Source.Type>();
  const listings = new Map<D4BrainContext, Map<string, string>>();

  const token = async (context: D4BrainContext) => {
    const known = tokens.get(context);
    if (known) return known;
    const file = NodePath.join(options.tokens, `d4-${context.toLowerCase()}.token`);
    const value = (await NodeFSP.readFile(file, "utf8")).trim();
    if (!value) throw unavailable();
    tokens.set(context, value);
    return value;
  };

  const call = async (
    context: D4BrainContext,
    signal: AbortSignal,
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    // @effect-diagnostics-next-line globalFetch:off -- One bounded loopback request that shares cancellation with the read.
    const response = await fetch(new URL(path, options.url), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${await token(context)}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (response.status === 401 || response.status === 403) tokens.delete(context);
    if (response.status === 404) throw new SecondBrainError({ code: "not_found" });
    if (!response.ok) throw unavailable();
    const text = await response.text();
    if (text.length > MAX_BODY) throw unavailable();
    return JSON.parse(text);
  };

  const revision = async (context: D4BrainContext, signal: AbortSignal, hit: typeof Hit.Type) => {
    // A revision never changes, so its text can be kept.
    const key = `${context}\n${hit.revision_id}`;
    const known = revisions.get(key);
    if (known) return known;
    const source = decodeSource(
      await call(context, signal, `/sources/${hit.source_id}?revision_id=${hit.revision_id}`),
    );
    revisions.set(key, source);
    while (revisions.size > REVISIONS_KEPT) revisions.delete(revisions.keys().next().value!);
    return source;
  };

  const listing = async (context: D4BrainContext, signal: AbortSignal, fresh: boolean) => {
    // A page added later is not in the kept list: the caller asks again with fresh.
    const known = listings.get(context);
    if (known && !fresh) return known;
    const byPath = new Map<string, string>();
    let after: string | null = null;
    for (let pages = 0; pages < 100; pages++) {
      const page = decodeSourcePage(
        await call(context, signal, `/sources?limit=100${after ? `&after=${after}` : ""}`),
      );
      for (const item of page.items)
        if (item.uri.startsWith(URI_PREFIX)) byPath.set(item.uri.slice(URI_PREFIX.length), item.id);
      after = page.next_cursor;
      if (!after) break;
    }
    listings.set(context, byPath);
    return byPath;
  };

  const guarded = <A>(run: (signal: AbortSignal) => Promise<A>): BrainEffect<A> =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => (isBrainError(cause) ? cause : unavailable()),
    });

  return KumbukaBrain.of({
    enabled: options.url !== "",
    search: Effect.fn("KumbukaBrain.search")((context, input) =>
      guarded(async (signal) => {
        const query = input.query.trim().slice(0, 2000);
        const results: BrainSearchResult[] = [];
        if (query) {
          const reply = decodeSearch(
            await call(context, signal, "/search", {
              query,
              top_k: Math.min(input.limit ?? 10, 20),
              mode: "hybrid",
            }),
          );
          const sources = await Promise.all(
            reply.results.map((hit) => revision(context, signal, hit)),
          );
          reply.results.forEach((hit, index) => {
            const source = sources[index]!;
            if (!source.uri.startsWith(URI_PREFIX)) return;
            const path = source.uri.slice(URI_PREFIX.length);
            // The store has no note kind or tag, so only the path filter applies.
            if (input.path && !path.startsWith(input.path)) return;
            const startLine = newlines(source.content.slice(0, hit.start_offset)) + 1;
            const span = source.content.slice(hit.start_offset, hit.end_offset).trimEnd();
            results.push({
              score: hit.rerank_score ?? hit.score,
              citation: {
                path,
                heading: hit.path === "/" ? "" : hit.path,
                startLine,
                endLine: startLine + newlines(span),
                hash: source.content_hash,
                excerpt: hit.text.slice(0, 4096),
              },
            });
          });
        }
        return {
          results,
          semanticStatus: "ready" as const,
          abstain: results.length === 0,
          truncated: false,
        };
      }),
    ),
    page: Effect.fn("KumbukaBrain.page")((context, path) =>
      guarded(async (signal) => {
        const id =
          (await listing(context, signal, false)).get(path) ??
          (await listing(context, signal, true)).get(path);
        if (!id) throw new SecondBrainError({ code: "not_found" });
        const source = decodeSource(await call(context, signal, `/sources/${id}`));
        return { content: source.content, hash: source.content_hash };
      }),
    ),
  });
};

export const layer = Layer.effect(
  KumbukaBrain,
  Effect.gen(function* () {
    const url = yield* Config.String("KUMBUKA_API_URL").pipe(Config.withDefault(""));
    const tokens = yield* Config.String("KUMBUKA_CLIENT_TOKENS").pipe(
      Config.withDefault(NodePath.join(NodeOS.homedir(), "kumbuka", "secrets", "clients")),
    );
    return make({ url: url.trim(), tokens });
  }).pipe(Effect.orDie),
);

/** For tests and for installs without Kumbuka: every read stays on the vault. */
export const layerDisabled = Layer.succeed(KumbukaBrain, make({ url: "", tokens: "" }));
