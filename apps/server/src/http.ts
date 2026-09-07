import Mime from "@effect/platform-node/Mime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  ENABLED_BY_DEFAULT_SKILL_MAX_COUNT,
  ENABLED_BY_DEFAULT_SKILL_NAME_MAX_CHARS,
  EnvironmentHttpApi,
} from "@d4research/contracts";
import { isDevProxiedPath } from "@d4research/shared/devProxy";
import { decodeOtlpTraceRecords } from "@d4research/shared/observability";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
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
import { statMediaFile, streamMediaFile, type OpenMediaFile } from "./assets/MediaFile.ts";
import {
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  storeAttachmentUpload,
  validateAttachmentUploadToken,
} from "./assets/AttachmentUpload.ts";
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
import type { ToolGuardPolicy } from "@d4research/contracts";
import {
  compressHandoffContext,
  compressHandoffContextLocal,
  compressHandoffContextWithFallback,
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

// A decoded JSON body must be a plain object before we read named fields off it.
// `typeof` alone is not enough: arrays and `null` are also `"object"`, and a
// bare array or `null` body would otherwise read every field as `undefined`.
export function isJsonObjectRequestBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
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
// HTML previews are agent output, not the app. The sandbox gives the document an
// opaque origin: scripts run, but same-origin cookies, storage, and API calls are
// out of reach. Relative sibling assets still load through their signed URLs.
const HTML_CONTENT_SECURITY_POLICY = "sandbox allow-scripts allow-forms allow-popups allow-modals";

// Types a browser may render as a document if a proxy strips the disposition
// header. Downloads of these fall back to octet-stream.
const DOWNLOAD_MIME_TYPE_PATTERN = /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/;
const isSafeDownloadMimeType = (mimeType: string): boolean =>
  DOWNLOAD_MIME_TYPE_PATTERN.test(mimeType) &&
  !/(?:^text\/html$|\/xml(?:$|-)|\+xml$)/i.test(mimeType.trim().toLowerCase());
const isSafeInlineVideoMimeType = (mimeType: string): boolean =>
  DOWNLOAD_MIME_TYPE_PATTERN.test(mimeType) && mimeType.toLowerCase().startsWith("video/");
const isSafeInlineDocumentMimeType = (mimeType: string): boolean =>
  mimeType.toLowerCase() === "application/pdf" || mimeType.toLowerCase() === "text/html";

/** RFC 6266 disposition with an ASCII fallback name plus a UTF-8 `filename*`. */
export function downloadContentDisposition(fileName?: string): string {
  if (fileName === undefined) {
    return "attachment";
  }
  // toWellFormed: encodeURIComponent throws URIError on unpaired surrogates.
  const sanitized = fileName.toWellFormed().replace(/[\p{Cc}"\\]/gu, "_");
  const asciiFallback = sanitized.replace(/[^\u0020-\u007e]/g, "_");
  const needsExtended = asciiFallback !== sanitized;
  const extendedName = encodeURIComponent(sanitized).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${asciiFallback}"${
    needsExtended ? `; filename*=UTF-8''${extendedName}` : ""
  }`;
}

export function assetResponseHeaders(
  filePath: string,
  options?: {
    readonly download?: boolean;
    readonly fileName?: string;
    readonly mimeType?: string;
  },
): Record<string, string> {
  const lowerPath = filePath.toLowerCase();
  const inlineMimeType = options?.mimeType?.split(";", 1)[0]?.trim();
  return {
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    ...(options?.download
      ? {
          "Content-Disposition": downloadContentDisposition(options.fileName),
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Type":
            options.mimeType !== undefined && isSafeDownloadMimeType(options.mimeType)
              ? options.mimeType
              : "application/octet-stream",
        }
      : inlineMimeType !== undefined && isSafeInlineVideoMimeType(inlineMimeType)
        ? { "Content-Type": inlineMimeType }
        : inlineMimeType !== undefined && isSafeInlineDocumentMimeType(inlineMimeType)
          ? {
              "Content-Type":
                inlineMimeType.toLowerCase() === "text/html"
                  ? "text/html; charset=utf-8"
                  : "application/pdf",
              ...(inlineMimeType.toLowerCase() === "text/html"
                ? { "Content-Security-Policy": HTML_CONTENT_SECURITY_POLICY }
                : {}),
            }
          : lowerPath.endsWith(".html") || lowerPath.endsWith(".htm")
            ? {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Security-Policy": HTML_CONTENT_SECURITY_POLICY,
              }
            : {}),
    ...(!options?.download && lowerPath.endsWith(".svg")
      ? { "Content-Security-Policy": SVG_CONTENT_SECURITY_POLICY }
      : {}),
  };
}

/** A single byte range for native video readers; unsupported range syntax uses the full file. */
function assetByteRange(header: string, size: bigint) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? BigInt(match[1]) : null;
  const last = match[2] ? BigInt(match[2]) : null;
  if (first !== null && last !== null && last < first) return null;
  if (size === 0n || (first !== null && first >= size) || (first === null && last === 0n)) {
    return { _tag: "Unsatisfiable" as const };
  }
  const start = first ?? (last! >= size ? 0n : size - last!);
  const end = first === null || last === null || last >= size ? size - 1n : last;
  if (!Number.isSafeInteger(Number(start)) || !Number.isSafeInteger(Number(end))) {
    return { _tag: "Unsatisfiable" as const };
  }
  return {
    _tag: "Range" as const,
    offset: start,
    bytesToRead: end - start + 1n,
    contentRange: `bytes ${start}-${end}/${size}`,
  };
}

export const assetFileResponse = Effect.fn("assetFileResponse")(function* (
  asset: {
    readonly path: string;
    readonly download?: boolean;
    readonly fileName?: string;
    readonly mimeType?: string;
    readonly file?: OpenMediaFile;
  },
  rangeHeader?: string,
  ifRangeHeader?: string,
  method: "GET" | "HEAD" = "GET",
) {
  const headers = assetResponseHeaders(asset.path, asset);
  const mediaFile = asset.file;
  const mediaInfo = mediaFile ? yield* statMediaFile(asset.path, mediaFile) : undefined;
  const isVideo = headers["Content-Type"]?.toLowerCase().startsWith("video/") === true;
  if (mediaFile && isVideo) {
    // Host videos can change in place. Do not invite conditional range requests
    // with validators that cannot establish byte-for-byte identity.
    headers["Cache-Control"] = "private, no-store";
  }
  let status = 200;
  let offset = 0n;
  let bytesToRead: bigint | undefined;
  if (isVideo) {
    headers["Accept-Ranges"] = "bytes";
    // If-Range requires a matching validator. A full response is safe when we cannot validate it.
    if (method === "GET" && rangeHeader && ifRangeHeader === undefined) {
      const fs = yield* FileSystem.FileSystem;
      const info = mediaInfo ?? (yield* fs.stat(asset.path));
      const range = assetByteRange(rangeHeader, info.size);
      if (range?._tag === "Unsatisfiable") {
        return HttpServerResponse.empty({
          status: 416,
          headers: { ...headers, "Content-Range": `bytes */${info.size}` },
        });
      }
      if (range?._tag === "Range") {
        status = 206;
        offset = range.offset;
        bytesToRead = range.bytesToRead;
        headers["Content-Range"] = range.contentRange;
      }
    }
  }
  if (mediaFile && mediaInfo) {
    const size = bytesToRead ?? mediaInfo.size;
    headers["Content-Type"] ??= Mime.getType(asset.path) ?? "application/octet-stream";
    headers["Content-Length"] = String(size);
    if (!isVideo) {
      headers["Last-Modified"] = mediaInfo.mtime.toUTCString();
      headers.ETag = `W/"${mediaInfo.size.toString(16)}-${mediaInfo.mtimeMs.toString(16)}"`;
    }
    if (method === "HEAD" || size === 0n) {
      return HttpServerResponse.empty({ status, headers });
    }
    const body = streamMediaFile(mediaFile, offset, size);
    if (!body) {
      return HttpServerResponse.text("File is too large to preview.", { status: 413 });
    }
    return HttpServerResponse.stream(body, {
      status,
      headers,
    });
  }
  return yield* HttpServerResponse.file(asset.path, { status, offset, bytesToRead, headers });
});

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
      const rawBody = yield* request.json;
      if (!isJsonObjectRequestBody(rawBody)) {
        return HttpServerResponse.jsonUnsafe(
          { ok: false, message: "Request body must be a JSON object." },
          { status: 400 },
        );
      }
      const body = cast<unknown, { text?: unknown; project?: unknown }>(rawBody);
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
// deterministic truncation as last resort — never an error) and attempts to
// persist the compressed summary (not the raw transcript) to local Memo.
export const handoffPrepareRouteLayer = HttpRouter.add(
  "POST",
  HANDOFF_PREPARE_PATH,
  Effect.gen(function* () {
    yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    return yield* Effect.gen(function* () {
      const rawBody = yield* request.json;
      if (!isJsonObjectRequestBody(rawBody)) {
        return HttpServerResponse.jsonUnsafe(
          { ok: false, message: "Request body must be a JSON object." },
          { status: 400 },
        );
      }
      const body = cast<unknown, HandoffPrepareBody>(rawBody);
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
        // Handoff must never block on compression or depend on the quota of the
        // provider the user is trying to leave: the helper bounds the attempt
        // and always resolves, falling back to deterministic truncation.
        compressed = yield* compressHandoffContextWithFallback({
          transcript: clipped,
          clipped,
          instanceId: compression.instanceId,
          model: compression.model,
          maxOutputCharacters: compression.maxOutputCharacters,
          customPrompt: compression.customPrompt,
          cwd: config.cwd,
        });
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
    return yield* assetFileResponse(
      asset,
      request.method === "GET" ? request.headers.range : undefined,
      request.headers["if-range"],
      request.method === "HEAD" ? "HEAD" : "GET",
    ).pipe(
      Effect.orElseSucceed(() => HttpServerResponse.text("Internal Server Error", { status: 500 })),
    );
  }),
);

/**
 * Paths the bundler emits: hashed chunks under `assets/`, plus any top-level
 * script/style/map. These must never fall back to `index.html`.
 */
const BUILD_ASSET_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".css", ".map", ".wasm"]);

export const attachmentUploadRouteLayer = HttpRouter.add(
  "POST",
  `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const token = url.value.pathname.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
    if (!token) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const claims = yield* validateAttachmentUploadToken(token);
    if (!claims) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const contentLengthHeader = request.headers["content-length"];
    if (
      contentLengthHeader !== undefined &&
      (!Number.isInteger(Number(contentLengthHeader)) ||
        Number(contentLengthHeader) !== claims.sizeBytes)
    ) {
      return HttpServerResponse.text("Content-Length must match the upload size.", {
        status: 400,
      });
    }

    // Keep the request stream in the route scope until the response is sent.
    const bodyPull = yield* Stream.toPull(request.stream);
    const stored = yield* storeAttachmentUpload(claims, Stream.fromPull(Effect.succeed(bodyPull)));
    return stored.ok
      ? HttpServerResponse.empty({ status: 204 })
      : HttpServerResponse.text(stored.detail, { status: stored.status });
  }),
);

export function isBuildAssetPath(relativePath: string): boolean {
  if (relativePath.startsWith("assets/")) {
    return true;
  }
  const lastDot = relativePath.lastIndexOf(".");
  return lastDot > 0 && BUILD_ASSET_EXTENSIONS.has(relativePath.slice(lastDot).toLowerCase());
}

const decodeBuildManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        file: Schema.String,
        css: Schema.optional(Schema.Array(Schema.String)),
        assets: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
  ),
);

const loadImmutableBuildAssets = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const staticDir =
    config.staticDir ?? (config.devUrl ? yield* ServerConfig.resolveStaticDir() : undefined);
  if (!staticDir) return new Set<string>();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(path.join(staticDir, ".vite", "manifest.json")).pipe(
    Effect.flatMap(decodeBuildManifest),
    Effect.map(
      (manifest) =>
        new Set(
          Object.values(manifest).flatMap((entry) => [
            entry.file,
            ...(entry.css ?? []),
            ...(entry.assets ?? []),
          ]),
        ),
    ),
    Effect.orElseSucceed(() => new Set<string>()),
  );
});

const openStaticFile = Effect.fn("openStaticFile")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  // Reject directories and special files before opening. Response metadata comes from the handle.
  const pathInfo = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
  if (pathInfo?.type !== "File") return null;
  const file = yield* fileSystem.open(filePath, { flag: "r" });
  const info = yield* file.stat;
  return info.type === "File" ? { file, info } : null;
});

const streamStaticFile = (file: FileSystem.File, size: bigint) =>
  Stream.unfold(
    0n,
    Effect.fnUntraced(function* (offset: bigint) {
      if (offset >= size) return;
      const remaining = size - offset;
      const bytes = yield* file.readAlloc(remaining < 65_536n ? remaining : 65_536n);
      if (Option.isNone(bytes)) return;
      return [bytes.value, offset + BigInt(bytes.value.byteLength)] as const;
    }),
  );

const handleStaticAndDevRequest = Effect.fn("handleStaticAndDevRequest")(
  function* (immutableBuildAssets: ReadonlySet<string>) {
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

    let opened = yield* openStaticFile(filePath);
    if (!opened) {
      if (isBuildAssetPath(staticRelativePath)) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      filePath = path.resolve(staticRoot, "index.html");
      opened = yield* openStaticFile(filePath);
      if (!opened) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
    }
    const fileInfo = opened.info;
    const mimeType = Mime.getType(filePath) ?? "application/octet-stream";
    const isHtml = mimeType === "text/html";

    // A hash-like name is not enough: custom static files can use the same naming pattern.
    const relativePath = path.relative(staticRoot, filePath).replaceAll("\\", "/");
    const immutable =
      !isHtml &&
      /^assets\/.+-[\w-]{8}\.[^/]+$/.test(relativePath) &&
      immutableBuildAssets.has(relativePath);
    const headers: Record<string, string> = {
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    };
    // Deployments can preserve HTML size and mtime while changing its bundle URLs.
    const modifiedAt = isHtml ? undefined : Option.getOrUndefined(fileInfo.mtime);
    const etag = modifiedAt
      ? `W/"${fileInfo.size.toString(16)}-${modifiedAt.getTime().toString(16)}"`
      : undefined;
    if (etag !== undefined && modifiedAt !== undefined) {
      headers.ETag = etag;
      headers["Last-Modified"] = modifiedAt.toUTCString();
    }

    // If-None-Match takes precedence over dates and uses weak comparison for
    // GET/HEAD, including when compression changes the transferred bytes.
    const ifNoneMatch = request.headers["if-none-match"];
    const ifModifiedSince = request.headers["if-modified-since"];
    const unchanged =
      ifNoneMatch !== undefined
        ? ifNoneMatch.split(",").some((value) => {
            const candidate = value.trim();
            return (
              candidate === "*" ||
              (etag !== undefined && candidate.replace(/^W\//i, "") === etag.slice(2))
            );
          })
        : ifModifiedSince !== undefined &&
          modifiedAt !== undefined &&
          Date.parse(modifiedAt.toUTCString()) <= Date.parse(ifModifiedSince);
    if (!isHtml && unchanged) {
      return HttpServerResponse.empty({
        status: 304,
        headers: { ...headers, Vary: "Accept-Encoding" },
      });
    }

    const contentType = isHtml ? "text/html; charset=utf-8" : mimeType;
    // The request scope closes the handle for GET, HEAD, 304, errors, and cancellation.
    // HEAD still passes through compression, which selects headers without reading the stream.
    return HttpServerResponse.stream(streamStaticFile(opened.file, fileInfo.size), {
      headers,
      contentType,
      contentLength: Number(fileInfo.size),
    });
  },
  Effect.catchTags({
    PlatformError: () =>
      Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
  }),
);

// Read the installed build's manifest once. Unknown files use revalidation.
export const staticAndDevRouteLayer = Layer.unwrap(
  loadImmutableBuildAssets.pipe(
    Effect.map((assets) => HttpRouter.add("GET", "*", handleStaticAndDevRequest(assets))),
  ),
);
