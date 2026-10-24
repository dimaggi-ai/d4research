import * as Layer from "effect/Layer";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@d4research/contracts";
import { DeepSeekAdapterV2Driver, probeDeepSeek } from "@d4research/provider-deepseek/server";
import { DeepSeekSettings } from "@d4research/provider-deepseek/settings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Context from "effect/Context";
import * as ServerSettings from "../../serverSettings.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";

const config = Schema.decodeSync(DeepSeekSettings)({});
const RequestBody = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.String })),
  tools: Schema.optional(Schema.Unknown),
});
const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(RequestBody));

it.live(
  "persists real DeepSeek replies and restores authoritative history after a session restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instanceId = ProviderInstanceId.make("deepseek-integration");
        const threadId = ThreadId.make("thread:deepseek-integration");
        const projectId = ProjectId.make("project:deepseek-integration");
        const selection = { instanceId, model: config.model };
        const requests: (typeof RequestBody.Type)[] = [];
        const paths: string[] = [];
        const client = HttpClient.make((request) =>
          Effect.gen(function* () {
            paths.push(new URL(request.url).pathname);
            assert.equal(
              Context.getOrUndefined(yield* Effect.context<never>(), FetchHttpClient.RequestInit)
                ?.redirect,
              "error",
            );
            if (request.method === "GET" && request.url === `${config.endpoint}/models`) {
              return HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify({ data: [{ id: config.model }] })),
              );
            }
            assert.equal(request.method, "POST");
            assert.equal(request.url, `${config.endpoint}/chat/completions`);
            assert.equal(request.body._tag, "Uint8Array");
            if (request.body._tag !== "Uint8Array")
              return yield* Effect.die("Expected a JSON request");
            const body = yield* decodeRequest(new TextDecoder().decode(request.body.body)).pipe(
              Effect.orDie,
            );
            assert.equal(body.tools, undefined);
            requests.push(body);
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  choices: [
                    {
                      finish_reason: "stop",
                      message: { content: `local answer ${requests.length}` },
                    },
                  ],
                  usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
                }),
              ),
            );
          }),
        );
        assert.isTrue(
          yield* probeDeepSeek(config).pipe(Effect.provideService(HttpClient.HttpClient, client)),
        );
        const adapter = yield* DeepSeekAdapterV2Driver.create({
          instanceId,
          displayName: undefined,
          environment: [],
          enabled: true,
          config,
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("deepseek:create"),
            threadId,
            projectId,
            createdBy: "user",
            creationSource: "web",
            title: "DeepSeek integration",
            modelSelection: selection,
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
          });
          const dispatch = (ordinal: number, text: string) =>
            orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`deepseek:start:${ordinal}`),
              threadId,
              messageId: MessageId.make(`deepseek:message:${ordinal}`),
              createdBy: "user",
              creationSource: "web",
              text,
              attachments: [],
              modelSelection: selection,
              dispatchMode: { type: "start_immediately" },
            });
          const wait = (ordinal: number) =>
            orchestrator.streamStoredEvents.pipe(
              Stream.filter(
                ({ event }) =>
                  event.type === "run.updated" &&
                  event.payload.ordinal === ordinal &&
                  (event.payload.status === "completed" || event.payload.status === "failed"),
              ),
              Stream.runHead,
              Effect.andThen(worker.drain()),
            );
          yield* dispatch(1, "Remember the verified constraint");
          yield* wait(1);
          const first = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(first.runs[0]?.status, "completed");
          assert.equal(
            first.messages.find((message) => message.role === "assistant")?.text,
            "local answer 1",
          );
          const firstItem = first.turnItems.find((item) => item.type === "assistant_message");
          assert.equal(firstItem?.type === "assistant_message" && firstItem.text, "local answer 1");
          const sessionId = first.providerThreads.find(
            (thread) => thread.id === first.runs[0]?.providerThreadId,
          )?.providerSessionId;
          assert.isDefined(sessionId);
          assert.isNotNull(sessionId);
          yield* orchestrator.dispatch({
            type: "provider-session.detach",
            commandId: CommandId.make("deepseek:detach"),
            threadId,
            providerSessionId: sessionId!,
          });
          yield* worker.drain();
          yield* dispatch(2, "Continue with that constraint");
          yield* wait(2);
          const second = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            second.runs.map((run) => run.status),
            ["completed", "completed"],
          );
          assert.equal(second.messages.filter((message) => message.role === "assistant").length, 2);
          assert.equal(
            second.turnItems.filter((item) => item.type === "assistant_message").length,
            2,
          );
          assert.equal(
            second.turnItems.some(
              (item) => item.type === "command_execution" || item.type === "file_change",
            ),
            false,
          );
          assert.equal(second.runtimeRequests.length, 0);
          assert.equal(requests.length, 2);
          const restored = requests[1]!.messages;
          assert.equal(
            restored.filter(
              (message) =>
                message.role === "user" && message.content === "Remember the verified constraint",
            ).length,
            1,
          );
          assert.equal(
            restored.filter(
              (message) => message.role === "assistant" && message.content === "local answer 1",
            ).length,
            1,
          );
          assert.equal(
            restored.filter(
              (message) =>
                message.role === "user" &&
                message.content.includes("Continue with that constraint"),
            ).length,
            1,
          );
          assert.deepEqual(paths, ["/v1/models", "/v1/chat/completions", "/v1/chat/completions"]);
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              {
                name: "deepseek-real-adapter",
                runtimePolicyOverride: {
                  approvalPolicy: "on-request",
                  sandboxPolicy: { type: "readOnly" },
                },
              },
              ProviderAdapterRegistry.layerFromAdapters([adapter]),
              {
                layerServerSettings: ServerSettings.layerTest({
                  providerInstances: {
                    [instanceId]: {
                      driver: ProviderDriverKind.make("deepseek"),
                      enabled: true,
                      config: { ...config, enabled: true },
                    },
                  },
                }).pipe(Layer.orDie),
              },
            ),
          ),
        );
      }),
    ),
);
