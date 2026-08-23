import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@d4research/contracts";
import * as Effect from "effect/Effect";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  fetchEnvironmentSkillsInventory,
  preparedEnvironmentFetchAuthorization,
} from "./skills.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("remote-environment"),
  label: "Remote",
  httpBaseUrl: "https://remote.example.test/stale-path",
  wsBaseUrl: "wss://remote.example.test",
});

const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: "wss://remote.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "remote-token" },
  target,
};

describe("fetchEnvironmentSkillsInventory", () => {
  it.effect(
    "uses the selected environment, workspace query, bearer credential, and wire schema",
    () => {
      const calls: Array<{
        readonly url: string;
        readonly authorization: string | null;
        readonly cache: RequestCache;
      }> = [];
      const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          cache: request.cache,
        });
        return Promise.resolve(
          Response.json({
            skills: [
              {
                name: "project-review",
                path: "/workspace/.agents/skills/project-review/SKILL.md",
                root: "project",
                kind: "skill",
                scope: "project",
                agents: ["all"],
                isSymlinked: false,
              },
            ],
          }),
        );
      }) satisfies typeof fetch;

      return Effect.gen(function* () {
        const result = yield* fetchEnvironmentSkillsInventory({
          prepared,
          cwd: "/workspace with spaces",
        });
        expect(result.skills.map((skill) => skill.name)).toEqual(["project-review"]);
        expect(calls).toEqual([
          {
            url: "https://remote.example.test/api/skills?cwd=%2Fworkspace+with+spaces",
            authorization: "Bearer remote-token",
            cache: "no-store",
          },
        ]);
      }).pipe(Effect.provide(remoteHttpClientLayer(fetchFn)));
    },
  );

  it.effect("rejects an invalid inventory response instead of accepting a permissive mock", () => {
    const fetchFn = (() =>
      Promise.resolve(
        Response.json({
          skills: [{ name: "not-enough-fields" }],
        }),
      )) satisfies typeof fetch;

    return Effect.flip(
      fetchEnvironmentSkillsInventory({ prepared, cwd: "/workspace" }).pipe(
        Effect.provide(remoteHttpClientLayer(fetchFn)),
      ),
    ).pipe(Effect.map((error) => expect(error).toBeDefined()));
  });

  it.effect("binds a DPoP proof to the exact remote inventory URL", () => {
    const proofInputs: Array<{ readonly method: string; readonly url: string }> = [];
    const dpopPrepared: PreparedConnection = {
      ...prepared,
      httpAuthorization: { _tag: "Dpop", accessToken: "relay-token" },
    };
    return Effect.gen(function* () {
      const auth = yield* preparedEnvironmentFetchAuthorization(
        dpopPrepared,
        "GET",
        "https://remote.example.test/api/skills?cwd=%2Fworkspace",
      );
      expect(auth).toEqual({
        headers: { authorization: "DPoP relay-token", dpop: "signed-proof" },
        credentials: undefined,
      });
      expect(proofInputs).toEqual([
        {
          method: "GET",
          url: "https://remote.example.test/api/skills?cwd=%2Fworkspace",
        },
      ]);
    }).pipe(
      Effect.provideService(
        ManagedRelayDpopSigner,
        ManagedRelayDpopSigner.of({
          thumbprint: Effect.succeed("thumbprint"),
          createProof: (input) =>
            Effect.sync(() => {
              proofInputs.push({ method: input.method, url: input.url });
              return "signed-proof";
            }),
        }),
      ),
    );
  });

  it.effect("binds fresh DPoP proofs to both provider-handoff POST endpoints", () => {
    const proofInputs: Array<{ readonly method: string; readonly url: string }> = [];
    const dpopPrepared: PreparedConnection = {
      ...prepared,
      httpAuthorization: { _tag: "Dpop", accessToken: "relay-token" },
    };
    const urls = [
      "https://remote.example.test/api/handoff/prepare",
      "https://remote.example.test/api/memory/handoff",
    ];
    return Effect.gen(function* () {
      const authorizations = [];
      for (const url of urls) {
        authorizations.push(
          yield* preparedEnvironmentFetchAuthorization(dpopPrepared, "POST", url),
        );
      }
      expect(authorizations).toEqual([
        {
          headers: { authorization: "DPoP relay-token", dpop: "signed-proof-1" },
          credentials: undefined,
        },
        {
          headers: { authorization: "DPoP relay-token", dpop: "signed-proof-2" },
          credentials: undefined,
        },
      ]);
      expect(proofInputs).toEqual(urls.map((url) => ({ method: "POST", url })));
    }).pipe(
      Effect.provideService(
        ManagedRelayDpopSigner,
        ManagedRelayDpopSigner.of({
          thumbprint: Effect.succeed("thumbprint"),
          createProof: (input) =>
            Effect.sync(() => {
              proofInputs.push({ method: input.method, url: input.url });
              return `signed-proof-${proofInputs.length}`;
            }),
        }),
      ),
    );
  });
});
