import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders } from "./environmentHttpAuth.ts";

const DEFAULT_SKILLS_INVENTORY_TIMEOUT_MS = 6_000;

/** Read the selected environment's user and project skills with its real HTTP credential. */
export const fetchEnvironmentSkillsInventory = Effect.fn(
  "clientRuntime.state.fetchEnvironmentSkillsInventory",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly cwd?: string | undefined;
  readonly timeoutMs?: number;
}) {
  const requestUrl = new URL(environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/skills"));
  if (input.cwd) requestUrl.searchParams.set("cwd", input.cwd);
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl.toString(),
    signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl.toString(),
    input.timeoutMs ?? DEFAULT_SKILLS_INVENTORY_TIMEOUT_MS,
    client.skills
      .inventory({
        headers,
        query: input.cwd ? { cwd: input.cwd } : {},
      })
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          cache: "no-store",
          ...(input.prepared.httpAuthorization === null ? { credentials: "include" as const } : {}),
        }),
      ),
  );
});

export function preparedEnvironmentFetchAuthorization(
  prepared: PreparedConnection,
  method: "GET" | "POST",
  url: string,
) {
  return Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const headers = yield* buildEnvironmentAuthHeaders(
      prepared.httpAuthorization,
      method,
      url,
      signer,
    );
    return {
      headers,
      credentials: prepared.httpAuthorization === null ? ("include" as const) : undefined,
    };
  });
}
