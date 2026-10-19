import {
  type BrainSearchResult,
  type SecondBrainSettings,
  SecondBrainError,
} from "@d4research/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const EmbedResponse = Schema.Struct({ embeddings: Schema.Array(Schema.Array(Schema.Number)) });
const decodeEmbedResponse = Schema.decodeUnknownSync(EmbedResponse);

export function reciprocalRankFusion(
  lexical: ReadonlyArray<BrainSearchResult>,
  semantic: ReadonlyArray<BrainSearchResult>,
  limit: number,
) {
  const results = new Map<string, BrainSearchResult>();
  for (const ranking of [lexical, semantic])
    ranking.forEach((result, i) => {
      const key = `${result.citation.path}:${result.citation.startLine}`;
      const prior = results.get(key);
      results.set(key, {
        citation: result.citation,
        score: (prior?.score ?? 0) + 1 / (60 + i + 1),
      });
    });
  return [...results.values()]
    .sort((a, b) => b.score - a.score || a.citation.path.localeCompare(b.citation.path))
    .slice(0, limit);
}
export class SecondBrainEmbeddings extends Context.Service<
  SecondBrainEmbeddings,
  {
    readonly rank: (
      settings: SecondBrainSettings["embeddings"],
      query: string,
      candidates: ReadonlyArray<BrainSearchResult>,
    ) => Effect.Effect<BrainSearchResult[], SecondBrainError>;
  }
>()("d4research/second-brain/SecondBrainEmbeddings") {}
const make = Effect.sync(() => {
  const cache = new Map<string, number[]>();
  return SecondBrainEmbeddings.of({
    rank: (settings, query, candidates) =>
      Effect.tryPromise({
        try: async (signal) => {
          const url = new URL(settings.baseUrl);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
            throw new SecondBrainError({ code: "unavailable" });
          const embed = async (input: string[]) => {
            // @effect-diagnostics-next-line globalFetch:off -- Bounded streaming transport shares cancellation with the embedding operation.
            const response = await fetch(new URL("/api/embed", url), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model: settings.model, input, truncate: false }),
              signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
            });
            if (!response.ok || !response.body) throw new SecondBrainError({ code: "unavailable" });
            const reader = response.body.getReader();
            let data = "";
            try {
              const decoder = new TextDecoder();
              while (true) {
                const part = await reader.read();
                if (part.done) break;
                data += decoder.decode(part.value, { stream: true });
                if (data.length > 2 * 1024 * 1024)
                  throw new SecondBrainError({ code: "unavailable" });
              }
              data += decoder.decode();
            } finally {
              await reader.cancel();
            }
            const result = decodeEmbedResponse(JSON.parse(data)).embeddings;
            if (
              result.length !== input.length ||
              result.some((v) => !v.length || v.length > 8192 || v.some((n) => !Number.isFinite(n)))
            )
              throw new SecondBrainError({ code: "unavailable" });
            return result.map((v) => [...v]);
          };
          const prefix = settings.model.startsWith("nomic-embed-text");
          const [q] = await embed([`${prefix ? "search_query: " : ""}${query}`]);
          const keys = candidates.map((c) =>
            JSON.stringify([
              url.origin,
              settings.model,
              c.citation.hash,
              c.citation.startLine,
              c.citation.excerpt,
            ]),
          );
          for (let i = 0; i < candidates.length; i += 16) {
            const missing = candidates
              .slice(i, i + 16)
              .map((c, j) => ({ c, key: keys[i + j]! }))
              .filter(({ key }) => !cache.has(key));
            if (!missing.length) continue;
            const vectors = await embed(
              missing.map(({ c }) => `${prefix ? "search_document: " : ""}${c.citation.excerpt}`),
            );
            missing.forEach(({ key }, j) => cache.set(key, vectors[j]!));
            while (cache.size > 10000) cache.delete(cache.keys().next().value!);
          }
          return candidates
            .map((c, i) => {
              const v = cache.get(keys[i]!)!;
              if (v.length !== q!.length) throw new SecondBrainError({ code: "unavailable" });
              const dot = v.reduce((sum, x, j) => sum + x * q![j]!, 0);
              const norm = Math.sqrt(
                v.reduce((sum, x) => sum + x * x, 0) * q!.reduce((sum, x) => sum + x * x, 0),
              );
              return { ...c, score: norm ? dot / norm : 0 };
            })
            .filter((r) => r.score > 0.25)
            .sort((a, b) => b.score - a.score)
            .slice(0, 50);
        },
        catch: () => new SecondBrainError({ code: "unavailable" }),
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(() => new SecondBrainError({ code: "unavailable" })),
      ),
  });
});
export const layer = Layer.effect(SecondBrainEmbeddings, make);
