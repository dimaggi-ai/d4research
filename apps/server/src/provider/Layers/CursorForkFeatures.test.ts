import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Crypto from "effect/Crypto";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { describe, expect, it } from "vite-plus/test";
import { HostProcessPlatform } from "@d4research/shared/hostProcess";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { cursorUsageResponseToLimits, readCursorUsageLimits } from "./cursorUsageLimits.ts";
import {
  discoverCursorSkills,
  hasCursorSkillMention,
  probeCursorSkills,
  rewriteCursorSkillMentions,
} from "../Drivers/CursorSkills.ts";
const runNode = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  >,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

describe("Cursor skills", () => {
  it("discovers recursive project skills with project precedence", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-home-",
        });
        const workspace = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-workspace-",
        });
        const writeSkill = Effect.fn("writeCursorSkill")(function* (
          root: string,
          name: string,
          contents: string,
        ) {
          const skillDirectory = path.join(root, name);
          yield* fileSystem.makeDirectory(skillDirectory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(skillDirectory, "SKILL.md"), contents);
        });

        yield* writeSkill(
          path.join(userHome, ".cursor", "skills"),
          "review",
          "---\ndescription: user review\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".agents", "skills", "nested"),
          "review",
          "---\nname: Review changes\ndescription: project review\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".cursor", "skills"),
          "internal",
          "---\nuser-invocable: false\n---\n",
        );
        yield* writeSkill(
          path.join(workspace, ".cursor", "skills"),
          "oversized",
          "x".repeat(1_000_001),
        );
        yield* fileSystem.makeDirectory(path.join(userHome, ".codex"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(userHome, ".codex", "skills"),
          "not a directory",
        );

        const skills = yield* discoverCursorSkills(workspace, { HOME: userHome });
        expect(skills).toEqual([
          {
            name: "internal",
            path: path.join(workspace, ".cursor", "skills", "internal", "SKILL.md"),
            scope: "project",
            enabled: true,
            userInvocable: false,
          },
          {
            name: "oversized",
            path: path.join(workspace, ".cursor", "skills", "oversized", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
          {
            name: "review",
            displayName: "Review changes",
            description: "project review",
            path: path.join(workspace, ".agents", "skills", "nested", "review", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ]);
        expect(
          (yield* probeCursorSkills(workspace, { HOME: userHome }).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ));

  it("treats a symlinked skill outside the root as a package boundary", async () =>
    await runNode(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const userHome = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-home-",
        });
        const workspace = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-workspace-",
        });
        const library = yield* fileSystem.makeTempDirectory({
          directory: NodeOS.tmpdir(),
          prefix: "cursor-skills-library-",
        });
        const writeSkill = Effect.fn("writeCursorSkill")(function* (
          directory: string,
          contents: string,
        ) {
          yield* fileSystem.makeDirectory(directory, { recursive: true });
          yield* fileSystem.writeFileString(path.join(directory, "SKILL.md"), contents);
        });

        // A skill package managed in a config repo and installed by symlink.
        // Its own SKILL.md must be discovered under the link name, but nothing
        // below the target may be walked.
        yield* writeSkill(path.join(library, "shared-review"), "---\ndescription: shared\n---\n");
        yield* writeSkill(path.join(library, "shared-review", "hidden"), "---\n---\n");
        const root = path.join(workspace, ".cursor", "skills");
        yield* fileSystem.makeDirectory(root, { recursive: true });
        yield* fileSystem.symlink(path.join(library, "shared-review"), path.join(root, "review"));

        const skills = yield* discoverCursorSkills(workspace, { HOME: userHome });
        expect(skills).toEqual([
          {
            name: "review",
            description: "shared",
            path: path.join(root, "review", "SKILL.md"),
            scope: "project",
            enabled: true,
          },
        ]);
        expect(
          (yield* probeCursorSkills(workspace, { HOME: userHome }).pipe(Effect.result))._tag,
        ).toBe("Success");
      }),
    ));

  it("rewrites only discovered skill mentions into Cursor slash invocations", () => {
    expect(hasCursorSkillMention("use $Review_Pr:V2 here")).toBe(true);
    expect(hasCursorSkillMention("please $review this")).toBe(true);
    expect(
      rewriteCursorSkillMentions("use $review, keep $HOME and 5$review", new Set(["review"])),
    ).toBe("use $review, keep $HOME and 5$review");
    expect(rewriteCursorSkillMentions("please $review this", new Set(["review"]))).toBe(
      "please /review this",
    );
  });

  it("rewrites currency-prefixed skill mentions into Cursor slash invocations", () => {
    const names = new Set(["review", "2spec", "20k", "100M", "1e6"]);
    for (const symbol of ["€", "£", "¥", "₹", "₩", "₿", "𑿝"]) {
      expect(hasCursorSkillMention(`please ${symbol}review this`)).toBe(true);
      expect(hasCursorSkillMention(`please ${symbol}review this`)).toBe(true);
      expect(rewriteCursorSkillMentions(`${symbol}review then ${symbol}2spec this`, names)).toBe(
        "/review then /2spec this",
      );
      const money = `${symbol}20 ${symbol}20k ${symbol}100M ${symbol}1e6`;
      expect(hasCursorSkillMention(money)).toBe(false);
      expect(rewriteCursorSkillMentions(money, names)).toBe(money);
      const prose = `5${symbol}review ${symbol}unknown`;
      expect(rewriteCursorSkillMentions(prose, names)).toBe(prose);
    }
  });

  it("detects and invokes digit-leading Cursor skills without rewriting money", () => {
    const names = new Set(["2spec", "20k", "100M", "1e6"]);
    // Repeated presence checks must not carry a global-regex cursor.
    expect(hasCursorSkillMention("use $2spec here")).toBe(true);
    expect(hasCursorSkillMention("use $2spec here")).toBe(true);
    expect(rewriteCursorSkillMentions("use $2spec here", names)).toBe("use /2spec here");
    expect(rewriteCursorSkillMentions("use $2spec here", new Set())).toBe("use $2spec here");
    for (const text of [
      "pay $20 tomorrow",
      "budget $20k here",
      "cost $100M total",
      "limit $1e6 here",
    ]) {
      expect(hasCursorSkillMention(text)).toBe(false);
      expect(rewriteCursorSkillMentions(text, names)).toBe(text);
    }
  });
});

describe("Cursor usage limits", () => {
  const checkedAt = "2026-09-16T00:00:00.000Z";

  it("uses the advertised percentages and billing-cycle reset", () => {
    const limits = cursorUsageResponseToLimits(
      {
        billingCycleEnd: "1789876386000",
        planUsage: { totalPercentUsed: 72.4, autoPercentUsed: 69.5, apiPercentUsed: 100 },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual(
      expect.arrayContaining([
        {
          id: "totalPercentUsed",
          kind: "monthly",
          label: "Overall",
          usedPercent: 72.4,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "autoPercentUsed",
          kind: "monthly",
          label: "Cursor Models",
          usedPercent: 69.5,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
        {
          id: "apiPercentUsed",
          kind: "monthly",
          label: "Other Models",
          usedPercent: 100,
          resetsAt: "2026-09-20T03:53:06.000Z",
        },
      ]),
    );
  });

  it("does not invent unused allowance for absent buckets", () => {
    expect(cursorUsageResponseToLimits({ planUsage: {} }, checkedAt).unavailable?.reason).toBe(
      "unsupported",
    );
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 0 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 0 }]);
    expect(
      cursorUsageResponseToLimits({ planUsage: { totalPercentUsed: 150 } }, checkedAt).windows,
    ).toEqual([{ id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 100 }]);
  });

  it("reads the instance's credentials and endpoint even when usage enabled is false", async () => {
    await runNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(path.join(directory, "cursor"));
        yield* fs.writeFileString(
          path.join(directory, "cursor", "auth.json"),
          '{"accessToken":"instance-token"}',
        );
        const client = HttpClient.make((request) => {
          expect(request.url).toBe(
            "https://cursor.example/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          );
          expect(request.method).toBe("POST");
          expect(request.headers.authorization).toBe("Bearer instance-token");
          expect(request.headers["connect-protocol-version"]).toBe("1");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ enabled: false, planUsage: { totalPercentUsed: 42 } }),
            ),
          );
        });
        yield* fs.makeDirectory(path.join(directory, ".cursor"));
        yield* fs.writeFileString(
          path.join(directory, ".cursor", "auth.json"),
          '{"accessToken":"instance-token"}',
        );
        for (const platform of ["linux", "darwin"] as const) {
          const limits = yield* readCursorUsageLimits(
            { apiEndpoint: "https://cursor.example/" },
            { XDG_CONFIG_HOME: directory, HOME: directory, AGENT_CLI_CREDENTIAL_STORE: "file" },
          ).pipe(
            Effect.provideService(HostProcessPlatform, platform),
            Effect.provideService(HttpClient.HttpClient, client),
          );
          expect(limits.windows[0]?.usedPercent).toBe(42);
        }
      }).pipe(Effect.scoped),
    );
  });

  it("never reads stale files for keychain or memory logins, but accepts an explicit auth token", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      for (const token of [undefined, "explicit-token"]) {
        const limits = await runNode(
          readCursorUsageLimits(
            { apiEndpoint: "" },
            {
              AGENT_CLI_CREDENTIAL_STORE: platform === "linux" ? "memory" : "default",
              ...(token ? { CURSOR_AUTH_TOKEN: token } : {}),
            },
            false,
            async () => {
              throw new Error("must not read Keychain before opt-in");
            },
          ).pipe(
            Effect.provideService(HostProcessPlatform, platform),
            Effect.provideService(
              FileSystem.FileSystem,
              FileSystem.makeNoop({
                readFileString: () => Effect.die("must not read an unrelated credential file"),
              }),
            ),
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                expect(token).toBe("explicit-token");
                expect(request.headers.authorization).toBe("Bearer explicit-token");
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    Response.json({ planUsage: { totalPercentUsed: 10 } }),
                  ),
                );
              }),
            ),
          ),
        );
        if (token) expect(limits.windows[0]?.usedPercent).toBe(10);
        else expect(limits.unavailable?.reason).toBe("unsupported");
      }
    }
  });

  it("reads the default macOS Cursor login from Keychain for limits", async () => {
    const limits = await runNode(
      readCursorUsageLimits({ apiEndpoint: "" }, {}, true, async () => "keychain-token").pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(
          FileSystem.FileSystem,
          FileSystem.makeNoop({
            readFileString: () => Effect.die("must not read a stale credential file"),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            expect(request.headers.authorization).toBe("Bearer keychain-token");
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ planUsage: { totalPercentUsed: 42 } }),
              ),
            );
          }),
        ),
      ),
    );
    expect(limits.windows[0]?.usedPercent).toBe(42);
  });

  it("reports a Keychain initialization failure without failing the provider refresh", async () => {
    const limits = await runNode(
      readCursorUsageLimits({ apiEndpoint: "" }, {}, true, async () => {
        throw new Error("Keychain initialization failed");
      }).pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("must not request limits without a login")),
        ),
      ),
    );
    expect(limits.unavailable?.reason).toBe("probeFailed");
  });

  it("does not read Keychain or send its token to a custom endpoint", async () => {
    for (const [apiEndpoint, environment] of [
      ["http://localhost:3000", {}],
      ["", { CURSOR_API_ENDPOINT: "http://localhost:3000" }],
      ["https://cursor-proxy.example", {}],
      ["", { CURSOR_API_ENDPOINT: "https://cursor-proxy.example" }],
    ] as const) {
      const limits = await runNode(
        readCursorUsageLimits({ apiEndpoint }, environment, true, async () => {
          throw new Error("must not read Keychain for a custom endpoint");
        }).pipe(
          Effect.provideService(HostProcessPlatform, "darwin"),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.die("must not send a Keychain credential to a proxy")),
          ),
        ),
      );
      expect(limits.unavailable?.reason).toBe("unsupported");
      expect(limits.unavailable?.message).toContain("default Cursor endpoint");
    }
  });

  it("reports failed requests without exposing credentials or response bodies", async () => {
    const limits = await runNode(
      readCursorUsageLimits({ apiEndpoint: "" }, { CURSOR_AUTH_TOKEN: "private-token" }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response("private response", { status: 401 }),
              ),
            ),
          ),
        ),
      ),
    );
    expect(limits.unavailable).toEqual({
      reason: "probeFailed",
      message: "Cursor could not read usage limits.",
    });
  });

  it("does not use a stored login for an explicit API key", async () => {
    const limits = await runNode(
      readCursorUsageLimits({ apiEndpoint: "" }, { CURSOR_API_KEY: "different-account" }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("must not request usage")),
        ),
      ),
    );
    expect(limits.unavailable?.reason).toBe("unsupported");
  });
});
