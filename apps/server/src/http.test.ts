import { NodeHttpServer } from "@effect/platform-node";
import { AuthOrchestrationOperateScope, AuthSessionId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import {
  buildHandoffMemoryText,
  isBuildAssetPath,
  isLoopbackHostname,
  makeSkillsInstallRouteLayer,
  resolveDevRedirectUrl,
  readHandoffEnabledSkills,
  selectHandoffCompressionPlan,
} from "./http.ts";
import { PortableSkillsInventory, type InstallSkillResult } from "./skillsInventory.ts";

const authenticatedRouteLayer = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
  authenticateHttpRequest: () =>
    Effect.succeed({
      sessionId: AuthSessionId.make("skill-route-test"),
      subject: "skill-route-test",
      method: "bearer-access-token",
      scopes: [AuthOrchestrationOperateScope],
    }),
});
const portableSkillsLayer = Layer.mock(PortableSkillsInventory)({
  get: Effect.succeed([]),
  refresh: Effect.succeed([]),
});

const withSkillInstallRoute = <A, E, R>(
  install: (input: {
    readonly url: string;
    readonly cwd?: string;
    readonly installAgyPlugin?: boolean;
  }) => Effect.Effect<InstallSkillResult>,
  run: Effect.Effect<A, E, R | HttpClient.HttpClient>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(makeSkillsInstallRouteLayer(install), {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(
        Layer.provide(Layer.merge(authenticatedRouteLayer, portableSkillsLayer)),
        Layer.build,
      );
      return yield* run;
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest));

const postInstall = (body: string) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.post("/api/skills/install", {
      body: HttpBody.text(body, "application/json"),
    });
    return {
      status: response.status,
      body: (yield* response.json) as Record<string, unknown>,
    };
  });

const postInstallJson = (body: unknown) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.post("/api/skills/install", {
      body: HttpBody.jsonUnsafe(body),
    });
    return {
      status: response.status,
      body: (yield* response.json) as Record<string, unknown>,
    };
  });

describe("static build assets", () => {
  it("treats bundler output as an asset, never a client route", () => {
    // A client left on a previous build requests chunks this build renamed.
    // These must 404 rather than fall back to index.html, which the browser
    // rejects on MIME grounds and reports as an unopenable panel.
    expect(isBuildAssetPath("assets/FilePreviewPanel-DhOl-_WG.js")).toBe(true);
    expect(isBuildAssetPath("assets/index-B0FU_a-4.css")).toBe(true);
    expect(isBuildAssetPath("service-worker.js")).toBe(true);
    expect(isBuildAssetPath("index-abc.js.map")).toBe(true);
  });

  it("leaves client routes to the SPA fallback", () => {
    expect(isBuildAssetPath("settings/skills")).toBe(false);
    expect(isBuildAssetPath("projects/meko-benchmark")).toBe(false);
    expect(isBuildAssetPath("index.html")).toBe(false);
  });
});

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("handoff prepare", () => {
  it("passes the transcript through when compression is disabled", () => {
    expect(
      selectHandoffCompressionPlan({
        enabled: false,
        backend: "provider",
        instanceId: "claude",
        model: "sonnet",
      }),
    ).toBe("passthrough");
  });

  it("uses the local model by default", () => {
    expect(selectHandoffCompressionPlan({ enabled: true, backend: "local" })).toBe("local");
  });

  it("uses a provider session only when fully configured", () => {
    expect(
      selectHandoffCompressionPlan({
        enabled: true,
        backend: "provider",
        instanceId: "claude",
        model: "sonnet",
      }),
    ).toBe("provider");
    expect(selectHandoffCompressionPlan({ enabled: true, backend: "provider" })).toBe("local");
    expect(
      selectHandoffCompressionPlan({ enabled: true, backend: "provider", instanceId: "claude" }),
    ).toBe("local");
  });

  it("stores the compressed summary with its source thread and target", () => {
    const text = buildHandoffMemoryText({
      summary: "Dense summary of the work.",
      sourceThreadId: "thread-source",
      sourceThreadTitle: "Voice integration",
      target: { instanceId: "claude", model: "claude-sonnet" },
      enabledSkills: ["focus-mode", "security-review"],
    });
    expect(text).toContain("Voice integration");
    expect(text).toContain("thread-source");
    expect(text).toContain("claude / claude-sonnet");
    expect(text).toContain("Dense summary of the work.");
    expect(text).toContain(
      "Configured global and chat skills to preserve: focus-mode, security-review",
    );
  });

  it("bounds and sanitizes enabled skill names from the untrusted request body", () => {
    const names = readHandoffEnabledSkills([
      "  focus-mode  ",
      "focus-mode",
      null,
      "",
      "x".repeat(129),
      ...Array.from({ length: 20 }, (_, index) => `skill-${index}`),
    ]);

    expect(names[0]).toBe("focus-mode");
    expect(names).toHaveLength(12);
    expect(new Set(names).size).toBe(names.length);
  });

  it("still builds a memory record without thread metadata", () => {
    const text = buildHandoffMemoryText({ summary: "Just the summary." });
    expect(text).toContain("d4research provider handoff.");
    expect(text).toContain("Just the summary.");
  });
});

describe("skill install HTTP boundary", () => {
  it.effect("decodes the explicit Agy opt-in and returns every success field", () => {
    const received: Array<{
      readonly url: string;
      readonly cwd?: string;
      readonly installAgyPlugin?: boolean;
    }> = [];
    return withSkillInstallRoute(
      (input) => {
        received.push(input);
        return Effect.succeed({
          ok: true,
          installed: ["review"],
          sharedRoots: ["claude-user", "junie-user", "agy-user"],
          agyPlugin: "installed",
        });
      },
      Effect.gen(function* () {
        const response = yield* postInstallJson({
          url: "https://example.test/review.git",
          cwd: "/workspace/project",
          installAgyPlugin: true,
        });
        expect(response).toEqual({
          status: 200,
          body: {
            ok: true,
            installed: ["review"],
            sharedRoots: ["claude-user", "junie-user", "agy-user"],
            agyPlugin: "installed",
          },
        });
        expect(received).toEqual([
          {
            url: "https://example.test/review.git",
            cwd: "/workspace/project",
            installAgyPlugin: true,
          },
        ]);
      }),
    );
  });

  it.effect("never turns truthy JSON values into an Agy plugin capability grant", () => {
    const optIns: boolean[] = [];
    return withSkillInstallRoute(
      (input) => {
        optIns.push(input.installAgyPlugin === true);
        return Effect.succeed({
          ok: true,
          installed: ["review"],
          sharedRoots: ["claude-user", "junie-user", "agy-user"],
          agyPlugin: "not-requested",
        });
      },
      Effect.gen(function* () {
        yield* postInstallJson({
          url: "https://example.test/review.git",
          installAgyPlugin: "true",
        });
        yield* postInstallJson({ url: "https://example.test/review.git" });
        expect(optIns).toEqual([false, false]);
      }),
    );
  });

  it.effect("maps installer validation, conflict, and internal failures to HTTP statuses", () => {
    const outcomes: InstallSkillResult[] = [
      { ok: false, status: 400, message: "Could not clone that repository." },
      { ok: false, status: 409, message: "Skill already exists." },
      { ok: false, status: 500, message: "Could not prepare every agent skills root." },
    ];
    return withSkillInstallRoute(
      () => Effect.succeed(outcomes.shift()!),
      Effect.gen(function* () {
        const body = { url: "https://example.test/review.git" };
        expect((yield* postInstallJson(body)).status).toBe(400);
        expect((yield* postInstallJson(body)).status).toBe(409);
        expect((yield* postInstallJson(body)).status).toBe(500);
      }),
    );
  });

  it.effect("keeps a portable-skill success when optional Agy installation fails", () =>
    withSkillInstallRoute(
      () =>
        Effect.succeed({
          ok: true,
          installed: ["review"],
          sharedRoots: ["claude-user", "junie-user", "agy-user"],
          agyPlugin: "failed",
        }),
      Effect.gen(function* () {
        const response = yield* postInstallJson({
          url: "https://example.test/review.git",
          installAgyPlugin: true,
        });
        expect(response.status).toBe(200);
        expect(response.body.agyPlugin).toBe("failed");
      }),
    ),
  );

  it.effect("rejects malformed JSON without invoking the installer", () => {
    let calls = 0;
    return withSkillInstallRoute(
      () => {
        calls += 1;
        return Effect.succeed({ ok: false, status: 400, message: "unused" });
      },
      Effect.gen(function* () {
        const response = yield* postInstall("{");
        expect(response.status).toBe(500);
        expect(response.body).toEqual({ ok: false, message: "Could not install the skill." });
        expect(calls).toBe(0);
      }),
    );
  });
});
