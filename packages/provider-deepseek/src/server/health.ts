import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { collectUint8StreamText } from "@d4research/provider-core/server/collectStreamText";
import { isLoopbackEndpoint, type DeepSeekSettings } from "../settings.ts";
const Catalog = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });

const decodeCatalog = Schema.decodeUnknownEffect(Schema.fromJsonString(Catalog));

export const probeDeepSeek = Effect.fn("DeepSeekHealth.probeDeepSeek")(
  function* (config: Pick<DeepSeekSettings, "endpoint" | "model">) {
    if (!isLoopbackEndpoint(config.endpoint)) return false;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(HttpClientRequest.get(`${config.endpoint.replace(/\/$/, "")}/models`))
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }));
    if (response.status !== 200) return false;
    const body = yield* collectUint8StreamText({ stream: response.stream, maxBytes: 128 * 1024 });
    if (body.truncated || body.invalidUtf8) return false;
    const catalog = yield* decodeCatalog(body.text);
    return catalog.data.some((model) => model.id === config.model);
  },
  Effect.timeout(2000),
  Effect.catch(() => Effect.succeed(false)),
);
