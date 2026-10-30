import {
  AuthAccessWriteScope,
  AuthRelayReadScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  SHARED_ENVIRONMENT_PROXY_PREFIX,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import * as SharedEnvironments from "./SharedEnvironments.ts";

export const layerApi = HttpApiBuilder.group(EnvironmentHttpApi, "sharedEnvironments", (handlers) =>
  Effect.gen(function* () {
    const service = yield* SharedEnvironments.SharedEnvironments;
    return handlers
      .handle(
        "catalog",
        Effect.fn("environment.sharedEnvironments.catalog")(
          function* () {
            const actor = yield* EnvironmentAuthenticatedPrincipal;
            return yield* service.catalog({
              sessionId: actor.sessionId,
              scopes: [...actor.scopes],
            });
          },
          Effect.catchTags({
            SharedEnvironmentError: (error) =>
              error.reason === "forbidden"
                ? failEnvironmentScopeRequired(AuthRelayReadScope)
                : failEnvironmentInternal("internal_error", error),
          }),
        ),
      )
      .handle(
        "publish",
        Effect.fn("environment.sharedEnvironments.publish")(
          function* ({ payload }) {
            const actor = yield* EnvironmentAuthenticatedPrincipal;
            return yield* service.publish(
              { sessionId: actor.sessionId, scopes: [...actor.scopes] },
              payload,
            );
          },
          Effect.catchTags({
            SharedEnvironmentError: (error) =>
              error.reason === "forbidden"
                ? failEnvironmentScopeRequired(AuthAccessWriteScope)
                : error.reason === "invalid_registration"
                  ? failEnvironmentInvalidRequest("invalid_command")
                  : failEnvironmentInternal("internal_error", error),
          }),
        ),
      );
  }),
);

export const layerProxy = Layer.unwrap(
  Effect.gen(function* () {
    const service = yield* SharedEnvironments.SharedEnvironments;
    return HttpRouter.add(
      "*",
      `${SHARED_ENVIRONMENT_PROXY_PREFIX}*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* service.proxy(request);
      }).pipe(
        Effect.catchTags({
          SharedEnvironmentError: (error) => {
            if (error.reason === "unauthenticated")
              return failEnvironmentAuthInvalid("invalid_credential");
            if (error.reason === "forbidden")
              return failEnvironmentScopeRequired(AuthRelayReadScope);
            return Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                { message: error.message },
                {
                  status: error.reason === "unavailable" ? 503 : 502,
                  headers: { "cache-control": "no-store" },
                },
              ),
            );
          },
        }),
      ),
    );
  }),
);
