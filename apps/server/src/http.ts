import Mime from "@effect/platform-node/Mime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { isDevProxiedPath } from "@t3tools/shared/devProxy";
import { decodeOtlpTraceRecords } from "@t3tools/shared/observability";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpMiddleware,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { OtlpTracer } from "effect/unstable/observability";

import * as ServerConfig from "./config.ts";
import { ASSET_ROUTE_PREFIX, resolveAsset } from "./assets/AssetAccess.ts";
import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { traceRelayRequest } from "./cloud/traceRelayRequest.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentScopeRequired,
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
} from "./auth/http.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import { browserApiCorsAllowedHeaders, browserApiCorsAllowedMethods } from "./httpCors.ts";
import { readToolGuardStatus } from "./toolGuardStatus.ts";
import {
  manageToolGuard,
  ToolGuardLifecycleAction,
  type ToolGuardLifecycleAction as ToolGuardLifecycleActionType,
} from "./toolGuardLifecycle.ts";
import { readToolGuardPolicy, writeToolGuardPolicy } from "./toolGuardPolicy.ts";
import type { ToolGuardPolicy } from "@t3tools/contracts";
import {
  compressHandoffContext,
  compressHandoffContextLocal,
  truncateHandoffTranscript,
} from "./handoffCompression.ts";
import {
  isShareSkillTargetRoot,
  readSkillsInventory,
  shareSkill,
  type SkillsInventoryEntry,
} from "./skillsInventory.ts";
import {
  DEFAULT_LOCAL_MEMO_BASE_URL,
  makeLocalMemoConnector,
} from "./mcp/toolkits/memory/connectors.ts";
import { ServerSettingsService } from "./serverSettings.ts";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const MISSION_CONTROL_SYSTEM_PATH = "/api/system-monitor";
const MISSION_CONTROL_SYSTEM_URL = "http://127.0.0.1:8093/sysmon";
const TOOL_GUARD_STATUS_PATH = "/api/tool-guard/status";
const TOOL_GUARD_POLICY_PATH = "/api/tool-guard/policy";
const SKILLS_PATH = "/api/skills";
const SKILLS_SHARE_PATH = "/api/skills/share";
const HANDOFF_MEMORY_PATH = "/api/memory/handoff";
const HANDOFF_COMPRESS_PATH = "/api/handoff/compress";
const HANDOFF_PREPARE_PATH = "/api/handoff/prepare";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"];
export const httpCompressionLayer = HttpRouter.middleware(HttpMiddleware.compression(), {
  global: true,
});

export const browserApiCorsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Dev uses credentialed requests from Vite or the Electron custom origin, so both must be
    // explicit. Packaged desktop omits credentials and uses Effect's default wildcard origin.
    //
    // T3CODE_DEV_ALLOWED_ORIGINS covers dev servers reached from a second
    // origin — a tailnet name, a LAN IP, a phone. Browser dev normally proxies
    // through Vite and is same-origin (no preflight at all), so this is a
    // safety net for the desktop renderer and any direct-to-backend caller.
    return HttpRouter.cors({
      ...(devOrigin
        ? {
            allowedOrigins: [devOrigin, ...DESKTOP_RENDERER_ORIGINS, ...config.devAllowedOrigins],
            credentials: true,
          }
        : {}),
      allowedMethods: browserApiCorsAllowedMethods,
      allowedHeaders: browserApiCorsAllowedHeaders,
      maxAge: 600,
    });
  }),
);

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

const authenticateRawRouteWithScope = (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(scope)) {
      return yield* failEnvironmentScopeRequired(scope);
    }
  });

export const serverEnvironmentHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "metadata",
  Effect.fnUntraced(function* (handlers) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    return handlers.handle(
      "descriptor",
      Effect.fn("environment.metadata.descriptor")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        return yield* serverEnvironment.getDescriptor;
      }, traceRelayRequest),
    );
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector.BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.orElseSucceed(() =>
          HttpServerResponse.text("Trace export failed.", { status: 502 }),
        ),
      );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const missionControlSystemRouteLayer = HttpRouter.add(
  "GET",
  MISSION_CONTROL_SYSTEM_PATH,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    return yield* httpClient.get(MISSION_CONTROL_SYSTEM_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
      Effect.map((body) =>
        HttpServerResponse.text(body, {
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json",
          },
        }),
      ),
      Effect.timeout("4 seconds"),
      Effect.catchCause((cause) =>
        Effect.logWarning("Mission Control system monitor proxy failed", { cause }).pipe(
          Effect.as(
            HttpServerResponse.jsonUnsafe(
              { error: "Mission Control is unavailable" },
              { status: 502 },
            ),
          ),
        ),
      ),
    );
  }),
);

export const toolGuardStatusRouteLayer = HttpRouter.add(
  "GET",
  TOOL_GUARD_STATUS_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const status = yield* readToolGuardStatus();
    return HttpServerResponse.jsonUnsafe(status, {
      headers: { "cache-control": "no-store" },
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const toolGuardLifecycleRouteLayer = HttpRouter.add(
  "POST",
  TOOL_GUARD_STATUS_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = cast<unknown, { action?: unknown }>(yield* request.json);
    if (
      typeof body.action !== "string" ||
      !ToolGuardLifecycleAction.includes(body.action as ToolGuardLifecycleActionType)
    ) {
      return HttpServerResponse.jsonUnsafe(
        { ok: false, message: "Expected a Tool Guard lifecycle action." },
        { status: 400 },
      );
    }
    const result = yield* manageToolGuard(body.action as ToolGuardLifecycleActionType);
    return HttpServerResponse.jsonUnsafe(result, {
      status: result.ok ? 200 : 409,
      headers: { "cache-control": "no-store" },
    });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const toolGuardPolicyReadRouteLayer = HttpRouter.add(
  "GET",
  TOOL_GUARD_POLICY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    return yield* Effect.gen(function* () {
      const read = yield* readToolGuardPolicy();
      if (!read) {
        return HttpServerResponse.jsonUnsafe(
          { ok: false, message: "No active policy found." },
          { status: 404, headers: { "cache-control": "no-store" } },
        );
      }
      return HttpServerResponse.jsonUnsafe(
        { ok: true, policy: read.policy, source: read.source },
        { headers: { "cache-control": "no-store" } },
      );
    }).pipe(
      Effect.orElseSucceed(() =>
        HttpServerResponse.jsonUnsafe(
          { ok: false, message: "Could not read policy." },
          { status: 500, headers: { "cache-control": "no-store" } },
        ),
      ),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const toolGuardPolicyWriteRouteLayer = HttpRouter.add(
  "PUT",
  TOOL_GUARD_POLICY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* Effect.gen(function* () {
      const body = cast<unknown, { policy?: unknown }>(yield* request.json);
      const policy = body.policy as ToolGuardPolicy | undefined;
      if (!policy || typeof policy.policy_id !== "string" || !Array.isArray(policy.rules)) {
        return HttpServerResponse.jsonUnsafe(
          { ok: false, message: "Invalid policy payload." },
          { status: 400 },
        );
      }
      yield* writeToolGuardPolicy(policy);
      return HttpServerResponse.jsonUnsafe(
        { ok: true, message: "Policy saved." },
        { headers: { "cache-control": "no-store" } },
      );
    }).pipe(
      Effect.orElseSucceed(() =>
        HttpServerResponse.jsonUnsafe(
          { ok: false, message: "Failed to save policy." },
          { status: 500 },
        ),
      ),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const skillsInventoryRouteLayer = HttpRouter.add(
  "GET",
  SKILLS_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationReadScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    // `cwd` scopes the project roots; without it only the user-level roots are scanned.
    const cwd = Option.isSome(url)
      ? url.value.searchParams.get("cwd")?.trim() || undefined
      : undefined;
    const skills = yield* readSkillsInventory({ cwd: cwd ?? process.cwd() }).pipe(
      Effect.orElseSucceed((): ReadonlyArray<SkillsInventoryEntry> => []),
    );
    return HttpServerResponse.jsonUnsafe({ skills }, { headers: { "cache-control": "no-store" } });
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const skillsShareRouteLayer = HttpRouter.add(
  "POST",
  SKILLS_SHARE_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* Effect.gen(function* () {
      const body = cast<unknown, { sourcePath?: unknown; targetRoot?: unknown; cwd?: unknown }>(
        yield* request.json,
      );
      const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath.trim() : "";
      if (!sourcePath || !isShareSkillTargetRoot(body.targetRoot)) {
        return HttpServerResponse.jsonUnsafe(
          { ok: false, message: "Expected a skill source path and a known target root." },
          { status: 400, headers: { "cache-control": "no-store" } },
        );
      }
      const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : process.cwd();
      const result = yield* shareSkill({ sourcePath, targetRoot: body.targetRoot }, { cwd });
      return result.ok
        ? HttpServerResponse.jsonUnsafe(
            { ok: true, targetPath: result.targetPath, mode: result.mode },
            { headers: { "cache-control": "no-store" } },
          )
        : HttpServerResponse.jsonUnsafe(
            { ok: false, message: result.message },
            { status: result.status, headers: { "cache-control": "no-store" } },
          );
    }).pipe(
      Effect.orElseSucceed(() =>
        HttpServerResponse.jsonUnsafe(
          { ok: false, message: "Could not share the skill." },
          { status: 500, headers: { "cache-control": "no-store" } },
        ),
      ),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const handoffMemoryRouteLayer = HttpRouter.add(
  "POST",
  HANDOFF_MEMORY_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* Effect.gen(function* () {
      const body = cast<unknown, { text?: unknown; project?: unknown }>(yield* request.json);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const project = typeof body.project === "string" ? body.project.trim() : undefined;
      if (!text || text.length > 20_000) {
        return HttpServerResponse.jsonUnsafe(
          { ok: false, message: "Handoff memory must contain 1–20,000 characters." },
          { status: 400 },
        );
      }
      const settingsService = yield* ServerSettingsService;
      const settings = yield* settingsService.getSettings;
      if (!settings.memory.localEnabled) {
        return HttpServerResponse.jsonUnsafe(
          { ok: false, message: "Local Memo is disabled in Settings → Connections." },
          { status: 503 },
        );
      }
      const connector = yield* makeLocalMemoConnector({
        baseUrl:
          process.env.T3CODE_LOCAL_MEMO_URL ??
          settings.memory.localBaseUrl ??
          DEFAULT_LOCAL_MEMO_BASE_URL,
        timeoutMs: 5_000,
      });
      const result = yield* connector.add(text, "t3research-provider-handoff", project);
      return HttpServerResponse.jsonUnsafe(
        { ok: result.ok },
        { headers: { "cache-control": "no-store" } },
      );
    }).pipe(
      Effect.orElseSucceed(() =>
        HttpServerResponse.jsonUnsafe(
          { ok: false, message: "Local Memo could not store the handoff context." },
          { status: 503 },
        ),
      ),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const handoffCompressRouteLayer = HttpRouter.add(
  "POST",
  HANDOFF_COMPRESS_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* Effect.gen(function* () {
      const body = cast<unknown, { transcript?: unknown }>(yield* request.json);
      const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
      if (!transcript) {
        return HttpServerResponse.jsonUnsafe(
          { ok: false, message: "Transcript must be non-empty." },
          { status: 400 },
        );
      }
      const settingsService = yield* ServerSettingsService;
      const settings = yield* settingsService.getSettings;
      const compression = settings.handoff.contextCompression;
      if (
        !compression.enabled ||
        (compression.backend === "provider" && (!compression.instanceId || !compression.model))
      ) {
        return HttpServerResponse.jsonUnsafe(
          { ok: false, message: "Handoff compression is not configured." },
          { status: 400 },
        );
      }
      let compressed: string;
      if (compression.backend === "provider" && compression.instanceId && compression.model) {
        const config = yield* ServerConfig.ServerConfig;
        compressed = yield* compressHandoffContext({
          transcript: transcript.slice(0, compression.maxInputCharacters),
          instanceId: compression.instanceId,
          model: compression.model,
          maxOutputCharacters: compression.maxOutputCharacters,
          customPrompt: compression.customPrompt,
          cwd: config.cwd,
        });
      } else {
        compressed = yield* compressHandoffContextLocal({
          transcript,
          model: compression.localModel,
          maxInputCharacters: compression.maxInputCharacters,
          maxOutputCharacters: compression.maxOutputCharacters,
          customPrompt: compression.customPrompt,
        });
      }
      return HttpServerResponse.jsonUnsafe(
        { ok: true, compressed },
        { headers: { "cache-control": "no-store" } },
      );
    }).pipe(
      Effect.catchTag("HandoffCompressionError", (error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { ok: false, message: error.detail },
            { status: 502, headers: { "cache-control": "no-store" } },
          ),
        ),
      ),
      Effect.orElseSucceed(() =>
        HttpServerResponse.jsonUnsafe(
          { ok: false, message: "Context compression failed." },
          { status: 500, headers: { "cache-control": "no-store" } },
        ),
      ),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

interface HandoffPrepareBody {
  readonly transcript?: unknown;
  readonly project?: unknown;
  readonly sourceThreadId?: unknown;
  readonly sourceThreadTitle?: unknown;
  readonly target?: unknown;
}

function readHandoffPrepareTarget(
  target: unknown,
): { instanceId: string; model: string } | undefined {
  if (typeof target !== "object" || target === null) return undefined;
  const { instanceId, model } = target as { instanceId?: unknown; model?: unknown };
  if (typeof instanceId !== "string" || typeof model !== "string") return undefined;
  const trimmedInstanceId = instanceId.trim();
  const trimmedModel = model.trim();
  if (!trimmedInstanceId || !trimmedModel) return undefined;
  return { instanceId: trimmedInstanceId, model: trimmedModel };
}

export type HandoffCompressionPlan = "passthrough" | "provider" | "local";

/**
 * Picks which compression path a handoff takes. Provider sessions are only
 * used when explicitly selected AND fully configured; everything else lands on
 * the free local model, and disabled compression passes the transcript through.
 */
export function selectHandoffCompressionPlan(compression: {
  readonly enabled: boolean;
  readonly backend: "local" | "provider";
  readonly instanceId?: string | undefined;
  readonly model?: string | undefined;
}): HandoffCompressionPlan {
  if (!compression.enabled) return "passthrough";
  if (compression.backend === "provider" && compression.instanceId && compression.model) {
    return "provider";
  }
  return "local";
}

export function buildHandoffMemoryText(input: {
  readonly summary: string;
  readonly sourceThreadId?: string | undefined;
  readonly sourceThreadTitle?: string | undefined;
  readonly target?: { readonly instanceId: string; readonly model: string } | undefined;
}): string {
  const lines: Array<string> = [];
  if (input.sourceThreadTitle || input.sourceThreadId) {
    const title = input.sourceThreadTitle || "untitled thread";
    lines.push(
      input.sourceThreadId
        ? `d4research provider handoff from thread ${title} (${input.sourceThreadId}).`
        : `d4research provider handoff from thread ${title}.`,
    );
  } else {
    lines.push("d4research provider handoff.");
  }
  if (input.target) {
    lines.push(`Receiving agent: ${input.target.instanceId} / ${input.target.model}.`);
  }
  lines.push("Shared context:", input.summary.trim());
  return lines.join("\n");
}

// One round-trip for the whole handoff: compresses the transcript per the
// handoff settings (local Ollama by default, provider session when selected,
// deterministic truncation as last resort — never an error) and persists the
// compressed summary (not the raw transcript) to local Memo in the same call.
export const handoffPrepareRouteLayer = HttpRouter.add(
  "POST",
  HANDOFF_PREPARE_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* Effect.gen(function* () {
      const body = cast<unknown, HandoffPrepareBody>(yield* request.json);
      const transcript = typeof body.transcript === "string" ? body.transcript.trim() : "";
      if (!transcript || transcript.length > 60_000) {
        return HttpServerResponse.jsonUnsafe(
          { ok: false, message: "Handoff transcript must contain 1–60,000 characters." },
          { status: 400 },
        );
      }
      const project = typeof body.project === "string" ? body.project.trim() : undefined;
      const sourceThreadId =
        typeof body.sourceThreadId === "string" ? body.sourceThreadId.trim() : undefined;
      const sourceThreadTitle =
        typeof body.sourceThreadTitle === "string" ? body.sourceThreadTitle.trim() : undefined;
      const target = readHandoffPrepareTarget(body.target);

      const settingsService = yield* ServerSettingsService;
      const settings = yield* settingsService.getSettings;
      const compression = settings.handoff.contextCompression;
      const clipped = transcript.slice(0, compression.maxInputCharacters);

      const plan = selectHandoffCompressionPlan(compression);
      let compressed: string;
      if (plan === "passthrough") {
        compressed = clipped;
      } else if (plan === "provider" && compression.instanceId && compression.model) {
        const config = yield* ServerConfig.ServerConfig;
        compressed = yield* compressHandoffContext({
          transcript: clipped,
          instanceId: compression.instanceId,
          model: compression.model,
          maxOutputCharacters: compression.maxOutputCharacters,
          customPrompt: compression.customPrompt,
          cwd: config.cwd,
        }).pipe(
          // Handoff must never block on compression.
          Effect.orElseSucceed(() =>
            truncateHandoffTranscript(clipped, compression.maxOutputCharacters),
          ),
        );
      } else {
        compressed = yield* compressHandoffContextLocal({
          transcript: clipped,
          model: compression.localModel,
          maxInputCharacters: compression.maxInputCharacters,
          maxOutputCharacters: compression.maxOutputCharacters,
          customPrompt: compression.customPrompt,
        });
      }

      // Persist the compressed summary to local Memo best-effort — a memory
      // outage must not block the handoff either.
      let memoryPersisted = false;
      if (settings.memory.localEnabled) {
        memoryPersisted = yield* Effect.gen(function* () {
          const connector = yield* makeLocalMemoConnector({
            baseUrl:
              process.env.T3CODE_LOCAL_MEMO_URL ??
              settings.memory.localBaseUrl ??
              DEFAULT_LOCAL_MEMO_BASE_URL,
            timeoutMs: 5_000,
          });
          const result = yield* connector.add(
            buildHandoffMemoryText({
              summary: compressed,
              sourceThreadId,
              sourceThreadTitle,
              target,
            }),
            "t3research-provider-handoff",
            project,
          );
          return result.ok;
        }).pipe(Effect.orElseSucceed(() => false));
      }

      return HttpServerResponse.jsonUnsafe(
        { ok: true, compressed, memoryPersisted },
        { headers: { "cache-control": "no-store" } },
      );
    }).pipe(
      Effect.orElseSucceed(() =>
        HttpServerResponse.jsonUnsafe(
          { ok: false, message: "Handoff preparation failed." },
          { status: 500, headers: { "cache-control": "no-store" } },
        ),
      ),
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);

export const assetRouteLayer = HttpRouter.add(
  "GET",
  `${ASSET_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const suffix = url.value.pathname.slice(`${ASSET_ROUTE_PREFIX}/`.length);
    const separatorIndex = suffix.indexOf("/");
    if (separatorIndex <= 0) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const asset = yield* resolveAsset(
      suffix.slice(0, separatorIndex),
      suffix.slice(separatorIndex + 1),
    );
    if (!asset) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    return yield* HttpServerResponse.file(asset.path, {
      status: 200,
      headers: {
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig.ServerConfig;
    if (config.devUrl && isDevProxiedPath(url.value.pathname)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir =
      config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    if (!ext) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!fileInfo || fileInfo.type !== "File") {
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem.readFile(filePath).pipe(Effect.orElseSucceed(() => null));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
    });
  }),
);
