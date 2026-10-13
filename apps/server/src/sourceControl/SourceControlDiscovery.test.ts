import { SourceControlProviderKind } from "@d4research/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import type * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { VcsProcessSpawnError } from "@d4research/contracts";

import * as ServerSettings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as AzureDevOpsCli from "@d4research/source-control-azure-devops/server/AzureDevOpsCli";
import * as AzureDevOpsPullRequestCli from "@d4research/source-control-azure-devops/server/AzureDevOpsPullRequestCli";
import * as BitbucketApi from "@d4research/source-control-bitbucket/server/BitbucketApi";
import * as BitbucketPullRequestApi from "@d4research/source-control-bitbucket/server/BitbucketPullRequestApi";
import * as GitHubApi from "@d4research/source-control-github/server/GitHubApi";
import * as GitHubPullRequestApi from "@d4research/source-control-github/server/GitHubPullRequestApi";
import * as GitLabCli from "@d4research/source-control-gitlab/server/GitLabCli";
import * as GitLabPullRequestCli from "@d4research/source-control-gitlab/server/GitLabPullRequestCli";
import * as ForgejoCli from "@d4research/source-control-forgejo/server/ForgejoCli";
import * as GitCafeApi from "@d4research/source-control-gitcafe/server/GitCafeApi";
import * as GitCafeCredentials from "@d4research/source-control-gitcafe/server/GitCafeCredentials";
import * as ForgejoSourceControlProvider from "@d4research/source-control-forgejo/server/ForgejoSourceControlProvider";
import * as ForgejoPullRequestProvider from "@d4research/source-control-forgejo/server/ForgejoPullRequestProvider";
import * as SourceControlDiscovery from "./SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";
import * as ServerSourceControlHost from "./ServerSourceControlHost.ts";
import * as SourceControlHost from "@d4research/source-control-core/server/SourceControlHost";

const layerSourceControlHostTest = ServerSourceControlHost.layer.pipe(
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provide(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
);

const layerSourceControlProviderRegistryTest = (input: {
  readonly bitbucket: Partial<BitbucketApi.BitbucketApi["Service"]>;
  readonly process: Partial<VcsProcess.VcsProcess["Service"]>;
}) =>
  SourceControlProviderRegistry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-source-control-registry-test-",
        }).pipe(Layer.provide(NodeServices.layer)),
        Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}),
        Layer.mock(AzureDevOpsPullRequestCli.AzureDevOpsPullRequestCli)({}),
        Layer.mock(BitbucketApi.BitbucketApi)(input.bitbucket),
        Layer.mock(BitbucketPullRequestApi.BitbucketPullRequestApi)({}),
        ServerSettings.ServerSettingsService.layerTest(),
        Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({}),
        Layer.mock(GitHubApi.GitHubApi)({}),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(GitLabCli.GitLabCli)({}),
        Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({}),
        Layer.mock(ForgejoCli.ForgejoCli)({ listLogins: () => Effect.succeed([]) }),
        Layer.mock(GitCafeApi.GitCafeApi)({}),
        Layer.mock(GitCafeCredentials.GitCafeCredentials)({
          cliEnv: () => Effect.succeed({}),
        }),
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
        Layer.mock(VcsProcess.VcsProcess)(input.process),
        ServerSourceControlHost.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(VcsProcess.VcsProcess)(input.process),
              ServerSettings.ServerSettingsService.layerTest(),
              Layer.mock(GitVcsDriver.GitVcsDriver)({}),
              Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
            ),
          ),
        ),
      ),
    ),
  );

const processOutput = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonEffect = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect("submits a Forgejo review without sending its summary in the preliminary GET", () => {
  const methods: string[] = [];
  const fetchReview = async (
    ...[input, init]: Parameters<Context.Service.Shape<typeof FetchHttpClient.Fetch>>
  ) => {
    const request = new Request(input instanceof Request ? input.url : String(input), {
      ...(init?.method === undefined ? {} : { method: init.method }),
      ...(init?.headers === undefined ? {} : { headers: init.headers }),
      ...(init?.body === undefined ? {} : { body: init.body }),
    });
    methods.push(request.method);
    if (request.method === "GET") {
      assert.strictEqual(request.url, "https://forgejo.test/api/v1/repos/maria/project/pulls/42");
      return new Response(
        encodeJson({
          number: 42,
          title: "Review target",
          body: "",
          html_url: "https://forgejo.test/maria/project/pulls/42",
          user: { login: "maria" },
          state: "open",
          merged: false,
          head: { ref: "feature", sha: "head", repo: null },
          base: { ref: "main", sha: "base", repo: null },
          created_at: "2026-09-13T00:00:00Z",
          updated_at: "2026-09-13T00:00:00Z",
          closed_at: null,
          merged_at: null,
          labels: [],
        }),
      );
    }
    assert.strictEqual(request.method, "POST");
    assert.strictEqual(
      request.url,
      "https://forgejo.test/api/v1/repos/maria/project/pulls/42/reviews",
    );
    assert.deepStrictEqual(JSON.parse(await request.text()), {
      event: "COMMENT",
      body: "Review summary",
      commit_id: "head",
      comments: [],
    });
    return new Response('{"id":1}', { status: 200 });
  };
  return Effect.gen(function* () {
    const cli = yield* ForgejoCli.make;
    const provider = yield* ForgejoPullRequestProvider.make.pipe(
      Effect.provideService(ForgejoCli.ForgejoCli, cli),
    );
    yield* provider.submitReview({
      cwd: "/repo",
      repository: "maria/project",
      host: "forgejo.test",
      number: 42,
      verdict: "comment",
      body: "Review summary",
      comments: [],
    });
    assert.deepStrictEqual(methods, ["GET", "POST"]);
  }).pipe(
    Effect.provide(layerSourceControlHostTest),
    Effect.provideService(
      FetchHttpClient.Fetch,
      Object.assign(fetchReview, { preconnect: () => undefined }),
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        exists: () => Effect.succeed(true),
        readFileString: () =>
          Effect.succeed(
            encodeJson({ hosts: { "forgejo.test": { type: "Application", token: "test-token" } } }),
          ),
      }),
    ),
    Effect.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: (input) => {
          if (input.command === "git") {
            assert.deepStrictEqual(input.args, ["remote", "-v"]);
            return Effect.succeed(
              processOutput("origin\thttps://forgejo.test/maria/project.git (fetch)"),
            );
          }
          assert.strictEqual(input.command, "fj");
          assert.deepStrictEqual(input.args, ["--host", "https://forgejo.test", "whoami"]);
          return Effect.succeed(processOutput(""));
        },
      }),
    ),
  );
});

it.effect("reads Forgejo checks without repository or viewer requests", () => {
  const paths: string[] = [];
  return Effect.gen(function* () {
    const provider = yield* ForgejoPullRequestProvider.make;
    const read = provider.getChangeRequestChecks;
    if (read === undefined) return yield* Effect.die("checks read missing");
    const result = yield* read({
      cwd: "/repo",
      repository: "acme/web",
      host: "forgejo.test",
      number: 1,
    });
    assert.strictEqual(result.state, "open");
    assert.strictEqual(result.checks[0]?.status, "failure");
    assert.deepStrictEqual(paths, [
      "repos/acme/web/pulls/1",
      "repos/acme/web/statuses/head?sort=recentupdate&limit=50&page=1",
      "repos/acme/web/statuses/head?sort=recentupdate&limit=50&page=2",
    ]);
  }).pipe(
    Effect.provide(
      Layer.mock(ForgejoCli.ForgejoCli)({
        api: (input) => {
          paths.push(input.path);
          assert.match(input.path, /^repos\/acme\/web\/(pulls\/1|statuses\/head)/);
          return Effect.succeed(
            processOutput(
              input.path.endsWith("pulls/1")
                ? `{"number":1,"title":"Checks","body":"","html_url":"https://forgejo.test/acme/web/pulls/1", "user":null,"state":"open","merged":false,
            "head":{"ref":"feature","sha":"head","repo":null},"base":{"ref":"main","sha":"base","repo":null},
            "created_at":"2026-09-16T00:00:00Z","updated_at":"2026-09-16T00:00:00Z","closed_at":null,"merged_at":null,"labels":[]}`
                : input.path.endsWith("page=1")
                  ? `[{"context":"build","status":"failure","description":null,"target_url":null,"updated_at":"2026-09-16T00:00:00Z"}]`
                  : "[]",
            ),
          );
        },
      }),
    ),
  );
});

it.effect.each([
  ["Ready", false, true, false, "mergeable"],
  ["Draft", true, false, true, "unknown"],
  ["Blocked", false, false, false, "unknown"],
  ["Unchecked", false, undefined, false, "unknown"],
  ["WIP: Legacy draft", undefined, false, true, "unknown"],
  ["[WIP] Legacy draft", undefined, false, true, "unknown"],
  ["WIP: Explicitly ready", false, false, false, "unknown"],
] as const)(
  "reads Forgejo mergeability for %s (draft=%s, mergeable=%s) across list, summary and detail",
  ([title, draft, mergeable, isDraft, mergeability]) => {
    const pr = {
      number: 42,
      title,
      body: "",
      html_url: "https://forgejo.test/maria/project/pulls/42",
      user: { login: "maria" },
      state: "open",
      merged: false,
      ...(draft === undefined ? {} : { draft }),
      ...(mergeable === undefined ? {} : { mergeable }),
      head: { ref: "feature", sha: "head", repo: null },
      base: { ref: "main", sha: "base", repo: null },
      created_at: "2026-09-16T00:00:00Z",
      updated_at: "2026-09-16T00:00:00Z",
      closed_at: null,
      merged_at: null,
      labels: [],
    };
    return Effect.gen(function* () {
      const provider = yield* ForgejoPullRequestProvider.make;
      const readSummary = provider.getChangeRequestSummary;
      if (readSummary === undefined) return yield* Effect.die("summary read missing");
      const input = { cwd: "/repo", repository: "maria/project", host: "forgejo.test", number: 42 };
      const list = yield* provider.listChangeRequests({
        ...input,
        state: "open",
        involvement: "all",
        viewer: "maria",
        limit: 10,
      });
      const summary = yield* readSummary(input);
      const detail = yield* provider.getChangeRequest(input);
      assert.strictEqual(list.items.length, 1);
      for (const result of [list.items[0]!, summary, detail]) {
        assert.strictEqual(result.mergeability, mergeability);
        assert.strictEqual(result.isDraft, isDraft);
      }
    }).pipe(
      Effect.provide(
        Layer.mock(ForgejoCli.ForgejoCli)({
          api: (input) => {
            const [path, query] = input.path.split("?");
            let response: unknown;
            switch (path) {
              case "repos/maria/project/pulls":
                response = new URLSearchParams(query).get("page") === "1" ? [pr] : [];
                break;
              case "repos/maria/project/pulls/42":
                response = pr;
                break;
              case "repos/maria/project":
                response = { full_name: "maria/project", permissions: { push: true, admin: true } };
                break;
              case "user":
                response = pr.user;
                break;
              case "repos/maria/project/statuses/head":
                response = [];
                break;
              default:
                return Effect.die(`Unexpected Forgejo request: ${input.path}`);
            }
            return encodeJsonEffect(response).pipe(Effect.orDie, Effect.map(processOutput));
          },
        }),
      ),
    );
  },
);

it.effect("loads Forgejo pull request references from files and commits views", () =>
  Effect.gen(function* () {
    const provider = yield* ForgejoSourceControlProvider.make;
    for (const reference of [
      "42",
      "#42",
      "https://forgejo.test/maria/project/pulls/42/",
      "https://forgejo.test/maria/project/pulls/42/",
      "https://forgejo.test/maria/project/pulls/42/files?w=1#diff-1",
      "http://forgejo.test:3000/git/maria/project/pulls/42/commits",
    ]) {
      const result = yield* provider.getChangeRequest({ cwd: "/repo", reference });
      assert.strictEqual(result.number, 42);
      assert.strictEqual(result.title, "Forgejo view reference");
    }
    const invalid = yield* provider
      .getChangeRequest({
        cwd: "/repo",
        reference: "https://forgejo.test/maria/project/pulls/42invalid/files",
      })
      .pipe(Effect.result);
    assert.strictEqual(invalid._tag, "Failure");
  }).pipe(
    Effect.provide(
      layerSourceControlHostTest.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
            Layer.mock(VcsProcess.VcsProcess)({}),
            Layer.mock(ForgejoCli.ForgejoCli)({
              resolveRepository: () =>
                Effect.succeed({
                  login: "work",
                  repository: "maria/project",
                  baseUrl: "https://forgejo.test",
                }),
              api: (input) => {
                assert.strictEqual(input.path, "repos/maria/project/pulls/42");
                return encodeJsonEffect({
                  number: 42,
                  title: "Forgejo view reference",
                  html_url: "https://forgejo.test/maria/project/pulls/42",
                  state: "open",
                  merged: false,
                  base: { ref: "main", sha: "base", repo: null },
                  head: { ref: "feature", sha: "head", repo: null },
                }).pipe(Effect.orDie, Effect.map(processOutput));
              },
            }),
          ),
        ),
      ),
    ),
  ),
);

it.effect(
  "loads Forgejo reactions on comments, reviews and inline threads and resolves review mutations",
  () => {
    const user = { login: "maria" };
    const review = {
      id: 8,
      body: "review body",
      user,
      state: "COMMENT",
      submitted_at: "2026-09-12T00:00:00Z",
      html_url: "https://forgejo.test/maria/project/pulls/2#issuecomment-37",
      comments_count: 1,
    };
    const comment = { id: 12, body: "ordinary", user, created_at: review.submitted_at };
    const responses: Record<string, unknown> = {
      user,
      "repos/maria/project/issues/2/comments": [comment],
      "repos/maria/project/pulls/2/reviews": [review],
      "repos/maria/project/pulls/2/reviews/8": review,
      "repos/maria/project/pulls/2/reviews/9": { ...review, id: 9, html_url: "" },
      "repos/maria/project/pulls/2/commits": [],
      "repos/maria/project/issues/2/reactions": [],
      "repos/maria/project/pulls/2/reviews/8/comments": [
        {
          ...comment,
          id: 38,
          body: "inline",
          path: "file.ts",
          position: 1,
          original_position: 1,
          commit_id: "head",
          original_commit_id: "head",
          resolver: null,
        },
      ],
      "repos/maria/project/issues/comments/12/reactions": [{ content: "+1", user }],
      "repos/maria/project/issues/comments/37/reactions": [{ content: "heart", user }],
      "repos/maria/project/issues/comments/38/reactions": [
        { content: "rocket", user: { login: "reviewer" } },
      ],
    };
    const writes: ForgejoCli.ForgejoApiInput[] = [];
    let reactionReads = 0;
    return Effect.gen(function* () {
      const provider = yield* ForgejoPullRequestProvider.make;
      const input = { cwd: "/repo", repository: "maria/project", host: "forgejo.test", number: 2 };
      const activity = yield* provider.getChangeRequestActivity(input);
      assert.deepStrictEqual(
        activity.comments.map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          reactions: entry.reactions,
        })),
        [
          {
            id: "12",
            kind: "issue-comment",
            reactions: [{ content: "thumbs-up", count: 1, actors: [], viewerHasReacted: true }],
          },
          {
            id: "review:8",
            kind: "review",
            reactions: [{ content: "heart", count: 1, actors: [], viewerHasReacted: true }],
          },
          {
            id: "38",
            kind: "review-comment",
            reactions: [
              { content: "rocket", count: 1, actors: ["reviewer"], viewerHasReacted: false },
            ],
          },
        ],
      );
      const inlineComment = activity.comments[2];
      assert.ok(inlineComment);
      assert.deepStrictEqual(activity.reviewThreads[0]?.comments, [inlineComment]);
      for (const reacted of [true, false]) {
        yield* provider.setReaction({ ...input, subjectId: "review:8", content: "heart", reacted });
        yield* provider.setReaction({ ...input, subjectId: "38", content: "rocket", reacted });
      }
      assert.deepStrictEqual(
        writes.map(({ path, method, body }) => ({ path, method, body })),
        [
          {
            path: "repos/maria/project/issues/comments/37/reactions",
            method: "POST",
            body: { content: "heart" },
          },
          {
            path: "repos/maria/project/issues/comments/38/reactions",
            method: "POST",
            body: { content: "rocket" },
          },
          {
            path: "repos/maria/project/issues/comments/37/reactions",
            method: "DELETE",
            body: { content: "heart" },
          },
          {
            path: "repos/maria/project/issues/comments/38/reactions",
            method: "DELETE",
            body: { content: "rocket" },
          },
        ],
      );
      const missing = yield* provider
        .setReaction({ ...input, subjectId: "review:9", content: "heart", reacted: true })
        .pipe(Effect.result);
      assert.strictEqual(missing._tag, "Failure");
      if (missing._tag === "Failure") assert.include(missing.failure.detail, "comment ID");
      assert.strictEqual(writes.length, 4);
      responses["repos/maria/project/pulls/2/reviews/8/comments"] = Array.from(
        { length: 501 },
        (_, index) => ({
          ...comment,
          id: 1000 + index,
          path: "file.ts",
          position: 1,
          original_position: 1,
          commit_id: "head",
          original_commit_id: "head",
          resolver: null,
        }),
      );
      for (let index = 0; index < 500; index++) {
        responses[`repos/maria/project/issues/comments/${1000 + index}/reactions`] = [];
      }
      reactionReads = 0;
      const bounded = yield* provider.getChangeRequestActivity(input);
      assert.strictEqual(bounded.reviewThreads.length, 500);
      assert.strictEqual(
        bounded.comments.filter((entry) => entry.kind === "review-comment").length,
        500,
      );
      assert.strictEqual(bounded.commentsTruncated, true);
      assert.strictEqual(reactionReads, 502);
    }).pipe(
      Effect.provide(
        Layer.mock(ForgejoCli.ForgejoCli)({
          api: (input) => {
            if (input.method) {
              writes.push(input);
              return Effect.succeed(processOutput("{}"));
            }
            const path = input.path.split("?")[0]!;
            if (/\/issues\/comments\/\d+\/reactions$/.test(path)) reactionReads++;
            assert.ok(Object.hasOwn(responses, path), `Unexpected Forgejo request: ${path}`);
            const page = Number(new URLSearchParams(input.path.split("?")[1]).get("page"));
            return encodeJsonEffect(page > 1 ? [] : responses[path]).pipe(
              Effect.orDie,
              Effect.map(processOutput),
            );
          },
        }),
      ),
    );
  },
);

it.effect("reports implemented tools separately from locally available executables", () => {
  const processMock = {
    run: (input: VcsProcess.VcsProcessInput) => {
      if (input.command === "git") {
        return Effect.succeed(processOutput("git version 2.51.0\n"));
      }
      if (input.command === "gh" && input.args[0] === "--version") {
        return Effect.succeed(processOutput("gh version 2.83.0\n"));
      }
      if (input.command === "gh" && input.args.join(" ") === "auth status --json hosts") {
        return Effect.succeed(
          processOutput(
            encodeJson({
              hosts: {
                "github.com": [
                  {
                    state: "success",
                    active: true,
                    host: "github.com",
                    login: "juliusmarminge",
                    tokenSource: "keyring",
                    gitProtocol: "ssh",
                  },
                ],
              },
            }),
          ),
        );
      }
      return Effect.fail(
        new VcsProcessSpawnError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          cause: new Error(`${input.command} not found`),
        }),
      );
    },
  } satisfies Partial<VcsProcess.VcsProcess["Service"]>;
  const layerTest = SourceControlDiscovery.layer.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-source-control-discovery-",
      }),
    ),
    Layer.provide(Layer.mock(VcsProcess.VcsProcess)(processMock)),
    Layer.provide(
      layerSourceControlProviderRegistryTest({
        process: processMock,
        bitbucket: {
          probeAuth: Effect.succeed({
            status: "unauthenticated",
            account: Option.none(),
            host: Option.some("bitbucket.org"),
            detail: Option.some(
              "Add a Bitbucket token in Settings → Source Control, or set the T3CODE_BITBUCKET_* environment variables on the server.",
            ),
          }),
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.deepStrictEqual(
      result.versionControlSystems.map((item) => ({
        kind: item.kind,
        implemented: item.implemented,
        status: item.status,
      })),
      [
        { kind: "git", implemented: true, status: "available" },
        { kind: "jj", implemented: false, status: "missing" },
      ],
    );
    assert.deepStrictEqual(
      result.sourceControlProviders.map((item) => ({
        kind: item.kind,
        status: item.status,
        auth: item.auth.status,
        account: item.auth.account,
      })),
      [
        {
          kind: SourceControlProviderKind.make("github"),
          status: "available",
          auth: "authenticated",
          account: Option.some("juliusmarminge"),
        },
        {
          kind: SourceControlProviderKind.make("gitlab"),
          status: "missing",
          auth: "unknown",
          account: Option.none(),
        },
        {
          kind: SourceControlProviderKind.make("azure-devops"),
          status: "missing",
          auth: "unknown",
          account: Option.none(),
        },
        {
          kind: SourceControlProviderKind.make("bitbucket"),
          status: "available",
          auth: "unauthenticated",
          account: Option.none(),
        },
        {
          kind: SourceControlProviderKind.make("forgejo"),
          status: "missing",
          auth: "unknown",
          account: Option.none(),
        },
        {
          kind: SourceControlProviderKind.make("gitcafe"),
          status: "missing",
          auth: "unknown",
          account: Option.none(),
        },
      ],
    );
    const bitbucket = result.sourceControlProviders.find((item) => item.kind === "bitbucket");
    assert.ok(bitbucket);
    assert.strictEqual(bitbucket.executable, undefined);
  }).pipe(Effect.provide(layerTest));
});

it.effect("probes provider authentication without exposing token details", () => {
  const processMock = {
    run: (input: VcsProcess.VcsProcessInput) => {
      if (input.args[0] === "--version") {
        return Effect.succeed(processOutput(`${input.command} version test\n`));
      }
      if (input.command === "gh" && input.args.join(" ") === "auth status --json hosts") {
        return Effect.succeed(
          processOutput(
            encodeJson({
              hosts: {
                "github.com": [
                  {
                    state: "success",
                    active: true,
                    host: "github.com",
                    login: "octocat",
                    tokenSource: "keyring",
                    gitProtocol: "ssh",
                  },
                ],
              },
            }),
          ),
        );
      }
      if (input.command === "glab" && input.args.join(" ") === "auth status") {
        return Effect.succeed(
          processOutput(`gitlab.com
Logged in to gitlab.com as gitlab-user
`),
        );
      }
      if (input.command === "tea" && input.args[0] === "login") {
        return Effect.succeed(
          processOutput(
            encodeJson([
              {
                name: "forgejo",
                url: "https://forgejo.example.com",
                ssh_host: "forgejo.example.com",
                user: "forgejo-user",
                valid: "true",
                default: "true",
              },
            ]),
          ),
        );
      }
      if (
        input.command === "az" &&
        input.args.join(" ") === "account show --query user.name -o tsv"
      ) {
        return Effect.succeed(processOutput("azure-user@example.com\n"));
      }
      if (input.command === "cafe" && input.args.slice(-3).join(" ") === "auth status --json") {
        return Effect.succeed(
          processOutput(
            encodeJson({ schemaVersion: 1, data: { host: "git.cafe", username: "cafe-user" } }),
          ),
        );
      }
      return Effect.fail(
        new VcsProcessSpawnError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          cause: new Error(`${input.command} not found`),
        }),
      );
    },
  } satisfies Partial<VcsProcess.VcsProcess["Service"]>;
  const layerTest = SourceControlDiscovery.layer.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-source-control-auth-discovery-",
      }),
    ),
    Layer.provide(Layer.mock(VcsProcess.VcsProcess)(processMock)),
    Layer.provide(
      layerSourceControlProviderRegistryTest({
        process: processMock,
        bitbucket: {
          probeAuth: Effect.succeed({
            status: "authenticated",
            account: Option.some("bitbucket-user"),
            host: Option.some("bitbucket.org"),
            detail: Option.none(),
          }),
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.deepStrictEqual(
      result.sourceControlProviders.map((item) => ({
        kind: item.kind,
        auth: item.auth.status,
        account: item.auth.account,
        detail: item.auth.detail,
      })),
      [
        {
          kind: SourceControlProviderKind.make("github"),
          auth: "authenticated",
          account: Option.some("octocat"),
          detail: Option.none(),
        },
        {
          kind: SourceControlProviderKind.make("gitlab"),
          auth: "authenticated",
          account: Option.some("gitlab-user"),
          detail: Option.none(),
        },
        {
          kind: SourceControlProviderKind.make("azure-devops"),
          auth: "authenticated",
          account: Option.some("azure-user@example.com"),
          detail: Option.none(),
        },
        {
          kind: SourceControlProviderKind.make("bitbucket"),
          auth: "authenticated",
          account: Option.some("bitbucket-user"),
          detail: Option.none(),
        },
        {
          kind: SourceControlProviderKind.make("forgejo"),
          auth: "authenticated",
          account: Option.some("forgejo-user"),
          detail: Option.none(),
        },
        {
          kind: SourceControlProviderKind.make("gitcafe"),
          auth: "authenticated",
          account: Option.some("cafe-user"),
          detail: Option.none(),
        },
      ],
    );
  }).pipe(Effect.provide(layerTest));
});

it.effect(
  "checks out fj pull refs and preserves existing branches and dirty files until forced",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const git = yield* VcsProcess.VcsProcess;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fj-checkout-" });
      const source = path.join(root, "source");
      const cwd = path.join(root, "checkout");
      yield* fs.makeDirectory(source);
      for (const args of [
        ["init", "-b", "main"],
        ["config", "user.name", "Test"],
        ["config", "user.email", "test@example.com"],
      ])
        yield* git.run({ operation: "test.setup", command: "git", cwd: source, args });
      yield* fs.writeFileString(path.join(source, "base.txt"), "base\n");
      for (const args of [
        ["add", "base.txt"],
        ["commit", "-m", "base"],
      ])
        yield* git.run({ operation: "test.setup", command: "git", cwd: source, args });
      const base = (yield* git.run({
        operation: "test.setup",
        command: "git",
        cwd: source,
        args: ["rev-parse", "HEAD"],
      })).stdout.trim();
      yield* git.run({
        operation: "test.setup",
        command: "git",
        cwd: root,
        args: ["clone", source, cwd],
      });
      yield* fs.writeFileString(path.join(source, "feature.txt"), "pull request change\n");
      for (const args of [
        ["add", "feature.txt"],
        ["commit", "-m", "feature"],
        ["update-ref", "refs/pull/42/head", "HEAD"],
      ])
        yield* git.run({ operation: "test.setup", command: "git", cwd: source, args });
      const head = (yield* git.run({
        operation: "test.setup",
        command: "git",
        cwd: source,
        args: ["rev-parse", "HEAD"],
      })).stdout.trim();
      const fetched: string[] = [];
      const host = yield* SourceControlHost.SourceControlHost;
      const provider = yield* ForgejoSourceControlProvider.make.pipe(
        Effect.provideService(
          SourceControlHost.SourceControlHost,
          SourceControlHost.SourceControlHost.of({
            settings: host.settings,
            git: host.git,
            process: {
              run: (input) => {
                if (input.args[0] !== "fetch") return git.run(input);
                const url = input.args[2];
                assert.isDefined(url);
                fetched.push(url!);
                // Only SSH transport is substituted; both paths fetch the real pull ref.
                return git.run({
                  ...input,
                  args: input.args.map((arg) =>
                    arg === "git@forgejo.test:reviewer/project.git" ? source : arg,
                  ),
                });
              },
            },
          }),
        ),
        Effect.provide(
          Layer.mock(ForgejoCli.ForgejoCli)({
            resolveRepository: () =>
              Effect.succeed({
                command: "fj",
                login: "work",
                repository: "reviewer/project",
                baseUrl: "https://forgejo.test",
              }),
            api: (input) => {
              assert.include(
                ["repos/reviewer/project", "repos/reviewer/project/pulls/42"],
                input.path,
              );
              return Effect.succeed(
                processOutput(
                  encodeJson(
                    input.path.endsWith("/pulls/42")
                      ? {
                          number: 42,
                          title: "Checkout",
                          html_url: "https://forgejo.test/reviewer/project/pulls/42",
                          state: "open",
                          merged: false,
                          base: { ref: "main", sha: base, repo: null },
                          head: { ref: "feature", sha: head, repo: null },
                        }
                      : {
                          full_name: "reviewer/project",
                          clone_url: source,
                          ssh_url: "git@forgejo.test:reviewer/project.git",
                          default_branch: "main",
                        },
                  ),
                ),
              );
            },
          }),
        ),
      );
      yield* provider.checkoutChangeRequest({
        cwd,
        reference: "https://forgejo.test/reviewer/project/pulls/42",
      });
      assert.strictEqual(
        (yield* git.run({
          operation: "test.verify",
          command: "git",
          cwd,
          args: ["branch", "--show-current"],
        })).stdout.trim(),
        "pulls/42",
      );
      assert.strictEqual(
        (yield* git.run({
          operation: "test.verify",
          command: "git",
          cwd,
          args: ["rev-parse", "HEAD"],
        })).stdout.trim(),
        head,
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(cwd, "feature.txt")),
        "pull request change\n",
      );
      for (const args of [
        ["checkout", "main"],
        ["branch", "-f", "pulls/42", "main"],
      ])
        yield* git.run({ operation: "test.setup", command: "git", cwd, args });
      yield* fs.writeFileString(path.join(cwd, "base.txt"), "uncommitted work\n");
      yield* provider.checkoutChangeRequest({ cwd, reference: "42" });
      assert.strictEqual(
        (yield* git.run({
          operation: "test.verify",
          command: "git",
          cwd,
          args: ["rev-parse", "HEAD"],
        })).stdout.trim(),
        base,
      );
      assert.strictEqual(yield* fs.exists(path.join(cwd, "feature.txt")), false);
      yield* provider.checkoutChangeRequest({
        cwd,
        reference: "42",
        force: true,
        context: {
          provider: {
            kind: SourceControlProviderKind.make("forgejo"),
            name: "Forgejo",
            baseUrl: "https://forgejo.test",
          },
          remoteName: "origin",
          remoteUrl: "git@forgejo.test:maria/project.git",
        },
      });
      assert.strictEqual(
        (yield* git.run({
          operation: "test.verify",
          command: "git",
          cwd,
          args: ["rev-parse", "HEAD"],
        })).stdout.trim(),
        head,
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(cwd, "base.txt")),
        "uncommitted work\n",
      );
      assert.strictEqual(
        yield* fs.readFileString(path.join(cwd, "feature.txt")),
        "pull request change\n",
      );
      assert.deepStrictEqual(fetched, [source, source, "git@forgejo.test:reviewer/project.git"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerSourceControlHost.layer.pipe(
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provideMerge(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
          Layer.provideMerge(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
