import Mime from "@effect/platform-node/Mime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ENABLED_BY_DEFAULT_SKILL_MAX_COUNT,
  ENABLED_BY_DEFAULT_SKILL_NAME_MAX_CHARS,
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
  requireEnvironmentScope,
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
  PortableSkillsInventory,
  readSkillsInventory,
  shareSkillAndRefreshInventory,
  installSkillFromGit,
} from "./skillsInventory.ts";
import { makeConfiguredMemoryConnector } from "./mcp/toolkits/memory/localConnector.ts";
import type { LocalMemoConnector, MemoryConnectorError } from "./mcp/toolkits/memory/connectors.ts";
import {
  deleteMemoAttachment,
  isMemoAttachmentDocumentToken,
  listMemoAttachments,
  MEMO_ATTACHMENT_MAX_CHARACTERS,
  persistMemoAttachment,
} from "./memoAttachment.ts";
import { ServerSettingsService } from "./serverSettings.ts";

const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const MISSION_CONTROL_SYSTEM_PATH = "/api/system-monitor";
const MISSION_CONTROL_SYSTEM_URL = "http://127.0.0.1:8093/sysmon";
const TOOL_GUARD_STATUS_PATH = "/api/tool-guard/status";
const TOOL_GUARD_POLICY_PATH = "/api/tool-guard/policy";
const SKILLS_SHARE_PATH = "/api/skills/share";
const SKILLS_INSTALL_PATH = "/api/skills/install";
const HANDOFF_MEMORY_PATH = "/api/memory/handoff";
const MEMO_ATTACHMENT_PATH = "/api/memory/attachment";
const MEMO_ATTACHMENTS_PATH = "/api/memory/attachments";
const MEMO_ATTACHMENT_DELETE_PATH = "/api/memory/attachment/delete";
const HANDOFF_COMPRESS_PATH = "/api/handoff/compress";
const HANDOFF_PREPARE_PATH = "/api/handoff/prepare";
// A provider selected for compression may be the provider whose usage limit
// triggered the handoff. Bound the entire attempt well inside the client's
// request deadline so quota errors and wedged CLIs always reach the model-free
// fallback while the user is still waiting on the same send.
export const PROVIDER_HANDOFF_COMPRESSION_TIMEOUT_MILLIS = 30_000;
/**
 * The prepare endpoint accepts a 60k-character transcript. A persisted
 * handoff adds bounded thread, target, and skill metadata, so the fallback
 * Memo endpoint must accept the complete resulting record as well.
 */
export const MAX_HANDOFF_MEMORY_CHARACTERS = 64_000;
const MAX_HANDOFF_TRANSCRIPT_CHARACTERS = 60_000;

export const isValidHandoffMemoryText = (text: string): boolean =>
  text.length > 0 && text.length <= MAX_HANDOFF_MEMORY_CHARACTERS;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"];
const SVG_CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export function assetResponseHeaders(filePath: string): Record<string, string> {
  return {
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    ...(filePath.toLowerCase().endsWith(".svg")
      ? { "Content-Security-Policy": SVG_CONTENT_SECURITY_POLICY }
      : {}),
  };
}

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

export const skillsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "skills",
  Effect.fnUntraced(function* (handlers) {
    yield* Effect.void;
    return handlers.handle(
      "inventory",
      Effect.fn("environment.skills.inventory")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        const cwd = args.query.cwd?.trim() || process.cwd();
        const skills = yield* readSkillsInventory({ cwd });
        return { skills };
      }),
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
      const result = yield* shareSkillAndRefreshInventory(
        { sourcePath, targetRoot: body.targetRoot },
        { cwd },
      );
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

type InstallSkillFromGit = typeof installSkillFromGit;

/**
 * Build the authenticated skill-install route around an explicit installer.
 * Production uses the real git lifecycle below; tests inject the boundary so
 * JSON decoding, opt-in propagation, and HTTP status mapping are exercised
 * without cloning a remote repository.
 */
export const makeSkillsInstallRouteLayer = (install: InstallSkillFromGit = installSkillFromGit) =>
  HttpRouter.add(
    "POST",
    SKILLS_INSTALL_PATH,
    Effect.gen(function* () {
      yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const portableSkills = yield* PortableSkillsInventory;
      return yield* Effect.gen(function* () {
        const body = cast<unknown, { url?: unknown; cwd?: unknown; installAgyPlugin?: unknown }>(
          yield* request.json,
        );
        const cwd =
          typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : process.cwd();
        const result = yield* install(
          {
            url: typeof body.url === "string" ? body.url : "",
            cwd,
            installAgyPlugin: body.installAgyPlugin === true,
          },
          { cwd },
        );
        if (result.ok) yield* portableSkills.refresh;
        return result.ok
          ? HttpServerResponse.jsonUnsafe(
              {
                ok: true,
                installed: result.installed,
                sharedRoots: result.sharedRoots,
                agyPlugin: result.agyPlugin,
              },
              { headers: { "cache-control": "no-store" } },
            )
          : HttpServerResponse.jsonUnsafe(
              { ok: false, message: result.message },
              { status: result.status, headers: { "cache-control": "no-store" } },
            );
      }).pipe(
        Effect.orElseSucceed(() =>
          HttpServerResponse.jsonUnsafe(
            { ok: false, message: "Could not install the skill." },
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

export const skillsInstallRouteLayer = makeSkillsInstallRouteLayer();
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
      if (!isValidHandoffMemoryText(text)) {
        return HttpServerResponse.jsonUnsafe(
          {
            ok: false,
            message: `Handoff memory must contain 1–${MAX_HANDOFF_MEMORY_CHARACTERS.toLocaleString()} characters.`,
          },
          { status: 400 },
        );
      }
      const connector = yield* makeConfiguredMemoryConnector();
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

const memoAttachmentJson = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: { "cache-control": "no-store" },
  });

const memoConnectorErrorResponse = (error: MemoryConnectorError) =>
  Effect.succeed(
    memoAttachmentJson(
      { ok: false, message: error.message },
      error.operation === "configure" ? 409 : 503,
    ),
  );

export const makeMemoAttachmentRouteLayer = <R>(
  makeConnector: () => Effect.Effect<LocalMemoConnector, MemoryConnectorError, R>,
) => {
  const createRoute = HttpRouter.add(
    "POST",
    MEMO_ATTACHMENT_PATH,
    Effect.gen(function* () {
      yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      return yield* Effect.gen(function* () {
        const decoded = yield* request.json.pipe(
          Effect.map((body) => ({ ok: true as const, body })),
          Effect.orElseSucceed(() => ({ ok: false as const })),
        );
        if (!decoded.ok) {
          return memoAttachmentJson({ ok: false, message: "Malformed request body." }, 400);
        }
        const body = cast<
          unknown,
          { documentToken?: unknown; name?: unknown; content?: unknown; project?: unknown }
        >(decoded.body);
        const documentToken =
          typeof body.documentToken === "string" ? body.documentToken.trim() : "";
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const content = typeof body.content === "string" ? body.content : "";
        const project = typeof body.project === "string" ? body.project.trim() : undefined;
        if (!isMemoAttachmentDocumentToken(documentToken)) {
          return memoAttachmentJson(
            { ok: false, message: "Invalid Memo attachment document token." },
            400,
          );
        }
        if (!name || name.length > 80) {
          return memoAttachmentJson(
            { ok: false, message: "Memo attachment name must contain 1-80 characters." },
            400,
          );
        }
        if (!content || content.length > MEMO_ATTACHMENT_MAX_CHARACTERS) {
          return memoAttachmentJson(
            {
              ok: false,
              message: `Memo attachment must contain 1-${MEMO_ATTACHMENT_MAX_CHARACTERS.toLocaleString()} characters.`,
            },
            400,
          );
        }
        if (project && project.length > 200) {
          return memoAttachmentJson(
            { ok: false, message: "Memo attachment project must not exceed 200 characters." },
            400,
          );
        }

        const connector = yield* makeConnector();
        const stored = yield* persistMemoAttachment({
          connector,
          documentToken,
          name,
          content,
          project,
        });
        return memoAttachmentJson({ ok: true, ...stored });
      }).pipe(
        Effect.catchTags({
          MemoAttachmentPersistenceError: (error) =>
            Effect.succeed(memoAttachmentJson({ ok: false, message: error.message }, 503)),
          MemoryConnectorError: memoConnectorErrorResponse,
        }),
        Effect.orElseSucceed(() =>
          memoAttachmentJson(
            { ok: false, message: "Local Memo could not store the attachment." },
            503,
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

  const listRoute = HttpRouter.add(
    "GET",
    MEMO_ATTACHMENTS_PATH,
    Effect.gen(function* () {
      yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
      return yield* Effect.gen(function* () {
        const connector = yield* makeConnector();
        const listed = yield* listMemoAttachments(connector);
        return memoAttachmentJson({
          ok: true,
          backend: listed.supported ? "builtin" : "memo-rest",
          ...listed,
        });
      }).pipe(
        Effect.catchTag("MemoryConnectorError", memoConnectorErrorResponse),
        Effect.orElseSucceed(() =>
          memoAttachmentJson(
            { ok: false, message: "Local Memo could not list stored attachments." },
            503,
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

  const deleteRoute = HttpRouter.add(
    "POST",
    MEMO_ATTACHMENT_DELETE_PATH,
    Effect.gen(function* () {
      yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      return yield* Effect.gen(function* () {
        const decoded = yield* request.json.pipe(
          Effect.map((body) => ({ ok: true as const, body })),
          Effect.orElseSucceed(() => ({ ok: false as const })),
        );
        if (!decoded.ok) {
          return memoAttachmentJson({ ok: false, message: "Malformed request body." }, 400);
        }
        const body = cast<unknown, { documentToken?: unknown }>(decoded.body);
        const documentToken =
          typeof body.documentToken === "string" ? body.documentToken.trim() : "";
        if (!isMemoAttachmentDocumentToken(documentToken)) {
          return memoAttachmentJson(
            { ok: false, message: "Invalid Memo attachment document token." },
            400,
          );
        }
        const connector = yield* makeConnector();
        const deleted = yield* deleteMemoAttachment({ connector, documentToken });
        if (!deleted.supported) {
          return memoAttachmentJson(
            {
              ok: false,
              supported: false,
              message:
                "The configured Memo REST backend cannot delete stored attachments. Remove them in that service.",
            },
            501,
          );
        }
        return memoAttachmentJson({ ok: true, ...deleted });
      }).pipe(
        Effect.catchTag("MemoryConnectorError", memoConnectorErrorResponse),
        Effect.orElseSucceed(() =>
          memoAttachmentJson(
            { ok: false, message: "Local Memo could not delete the attachment." },
            503,
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

  return Layer.mergeAll(createRoute, listRoute, deleteRoute);
};

export const memoAttachmentRouteLayer = makeMemoAttachmentRouteLayer(() =>
  makeConfiguredMemoryConnector(),
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
  readonly enabledSkills?: unknown;
  /** Skip compression entirely and hand the transcript over as-is. */
  readonly bypassCompression?: unknown;
}

export function readHandoffEnabledSkills(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  const names: Array<string> = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim();
    if (!name || name.length > ENABLED_BY_DEFAULT_SKILL_NAME_MAX_CHARS || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= ENABLED_BY_DEFAULT_SKILL_MAX_COUNT) break;
  }
  return names;
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

/**
 * The prepare route's actual plan: a research bypass wins over every
 * compression setting — pipeline evidence crosses the handoff verbatim.
 */
export function resolveHandoffPreparePlan(
  compression: Parameters<typeof selectHandoffCompressionPlan>[0],
  bypassCompression: boolean,
): HandoffCompressionPlan {
  return bypassCompression ? "passthrough" : selectHandoffCompressionPlan(compression);
}

export function buildHandoffMemoryText(input: {
  readonly summary: string;
  readonly sourceThreadId?: string | undefined;
  readonly sourceThreadTitle?: string | undefined;
  readonly target?: { readonly instanceId: string; readonly model: string } | undefined;
  readonly enabledSkills?: ReadonlyArray<string> | undefined;
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
  if (input.enabledSkills && input.enabledSkills.length > 0) {
    lines.push(`Configured global and chat skills to preserve: ${input.enabledSkills.join(", ")}.`);
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
      if (!transcript || transcript.length > MAX_HANDOFF_TRANSCRIPT_CHARACTERS) {
        return HttpServerResponse.jsonUnsafe(
          {
            ok: false,
            message: `Handoff transcript must contain 1–${MAX_HANDOFF_TRANSCRIPT_CHARACTERS.toLocaleString()} characters.`,
          },
          { status: 400 },
        );
      }
      const project = typeof body.project === "string" ? body.project.trim() : undefined;
      const sourceThreadId =
        typeof body.sourceThreadId === "string" ? body.sourceThreadId.trim() : undefined;
      const sourceThreadTitle =
        typeof body.sourceThreadTitle === "string" ? body.sourceThreadTitle.trim() : undefined;
      const target = readHandoffPrepareTarget(body.target);
      const enabledSkills = readHandoffEnabledSkills(body.enabledSkills);

      const settingsService = yield* ServerSettingsService;
      const settings = yield* settingsService.getSettings;
      const compression = settings.handoff.contextCompression;
      // Research pipelines opt out of compression: evidence must survive the
      // handoff verbatim, so the transcript skips the input clip too (the
      // 60k transport guard above still applies).
      const bypassCompression = body.bypassCompression === true;
      const clipped = bypassCompression
        ? transcript
        : transcript.slice(0, compression.maxInputCharacters);

      const plan = resolveHandoffPreparePlan(compression, bypassCompression);
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
          Effect.timeout(PROVIDER_HANDOFF_COMPRESSION_TIMEOUT_MILLIS),
          // Handoff must never block on compression or depend on the quota of
          // the provider the user is trying to leave.
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

      // Persist the compressed summary to local Memo when it is enabled, and
      // report the result. The client still attaches the summary to the
      // receiving turn when memoryPersisted is false — Memo is a search
      // mirror, not a gate on the switch.
      let memoryPersisted = false;
      if (settings.memory.localEnabled) {
        memoryPersisted = yield* Effect.gen(function* () {
          const connector = yield* makeConfiguredMemoryConnector();
          const result = yield* connector.add(
            buildHandoffMemoryText({
              summary: compressed,
              sourceThreadId,
              sourceThreadTitle,
              target,
              enabledSkills,
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
      headers: assetResponseHeaders(asset.path),
    }).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

/**
 * Paths the bundler emits: hashed chunks under `assets/`, plus any top-level
 * script/style/map. These must never fall back to `index.html`.
 */
const BUILD_ASSET_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".css", ".map", ".wasm"]);

export function isBuildAssetPath(relativePath: string): boolean {
  if (relativePath.startsWith("assets/")) {
    return true;
  }
  const lastDot = relativePath.lastIndexOf(".");
  return lastDot > 0 && BUILD_ASSET_EXTENSIONS.has(relativePath.slice(lastDot).toLowerCase());
}

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
      // The SPA fallback exists for client routes. A build asset is not one:
      // answering a missing chunk with index.html makes the browser reject it
      // on MIME grounds ("Expected a JavaScript-or-Wasm module script"), which
      // is what a client left on a previous build sees when it lazily loads a
      // chunk the new build renamed. A 404 states the real problem and lets
      // the client recover.
      if (isBuildAssetPath(staticRelativePath)) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
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
