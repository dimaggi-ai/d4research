import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS } from "@d4research/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerSettingsService } from "../serverSettings.ts";
import { DecisionError, DecisionService, make } from "./DecisionService.ts";

const reply = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

const score = (value: number) => ({
  model: "openjev-0.1",
  answers: {
    relevance: {
      type: "score",
      score: value,
      legend: {},
      probabilities: {},
      confidence: 0.9,
    },
  },
});

type Answer = (url: string, body: unknown) => Response;

const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const service = (answer: Answer, baseUrl = "http://judge.test/") =>
  DecisionService.pipe(
    Effect.provide(
      Layer.effect(DecisionService, make).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request, url) =>
                Effect.sync(() =>
                  HttpClientResponse.fromWeb(
                    request,
                    answer(
                      url.toString(),
                      request.body._tag === "Uint8Array"
                        ? decodeBody(new TextDecoder().decode(request.body.body))
                        : undefined,
                    ),
                  ),
                ),
              ),
            ),
            Layer.mock(ServerSettingsService)({
              getSettings: Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                decision: { baseUrl, model: "openjev-0.1" },
              }),
            }),
          ),
        ),
      ),
    ),
  );

const noul = { ok: { type: "noul" as const, instructions: "Is `state` fine?" } };

it.effect("sends typed questions to the configured System One endpoint", () =>
  Effect.gen(function* () {
    const requests: Array<{ url: string; body: unknown }> = [];
    const decisions = yield* service((url, body) => {
      requests.push({ url, body });
      return reply({ model: "openjev-0.1", answers: { ok: { type: "noul", noul: 0.8 } } });
    });
    const result = yield* decisions.evaluate({ state: "fine", questions: noul });
    expect(result.answers.ok).toEqual({ type: "noul", noul: 0.8 });
    expect(requests).toEqual([
      {
        url: "http://judge.test/v1/systemone",
        body: { state: "fine", questions: noul, model: "openjev-0.1" },
      },
    ]);
  }),
);

it.effect("ranks candidates best first and applies the limit", () =>
  Effect.gen(function* () {
    const scores: Record<string, number> = { weak: 0, strong: 3, partial: 1.5 };
    const decisions = yield* service((_url, body) => {
      const { state } = body as { state: { candidate: string } };
      return reply(score(scores[state.candidate]!));
    });
    const { results } = yield* decisions.rank({
      query: "q",
      candidates: Object.keys(scores).map((text) => ({ id: `id-${text}`, text })),
      limit: 2,
    });
    expect(results).toEqual([
      { id: "id-strong", relevance: 1, confidence: 0.9 },
      { id: "id-partial", relevance: 0.5, confidence: 0.9 },
    ]);
  }),
);

const failure = (answer: Answer, baseUrl?: string) =>
  service(answer, baseUrl).pipe(
    Effect.flatMap((decisions) => decisions.evaluate({ state: "s", questions: noul })),
    Effect.flip,
  );

it.effect("makes no request while no endpoint is set", () =>
  Effect.gen(function* () {
    let calls = 0;
    const error = yield* failure(() => {
      calls++;
      return reply({});
    }, "");
    expect(error).toBeInstanceOf(DecisionError);
    expect(error.reason).toBe("disabled");
    expect(calls).toBe(0);
  }),
);

it.effect("separates rejected requests from an unusable endpoint", () =>
  Effect.gen(function* () {
    const invalid = yield* failure(() => reply({ detail: "bad question" }, 422));
    expect(invalid.reason).toBe("rejected");
    expect(invalid.message).toContain("bad question");
    expect((yield* failure(() => reply("down", 503))).reason).toBe("unavailable");
    expect((yield* failure(() => reply("not json"))).reason).toBe("unavailable");
    expect((yield* failure(() => reply({ answers: "x" }))).reason).toBe("unavailable");
  }),
);
