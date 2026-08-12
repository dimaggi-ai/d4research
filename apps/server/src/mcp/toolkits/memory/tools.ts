import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { HttpClient } from "effect/unstable/http";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Path from "effect/Path";
import * as ServerConfig from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { MemoryConnectorError, MemoryEntry } from "./connectors.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  HttpClient.HttpClient,
  ServerSettingsService,
  ServerConfig.ServerConfig,
  Path.Path,
];

const Connector = Schema.Literal("local").pipe(
  Schema.annotate({ description: 'Memory backend. Currently only on-device Memo ("local").' }),
);

export const MemorySearchInput = Schema.Struct({
  connector: Connector,
  query: Schema.String.pipe(
    Schema.annotate({ description: "Natural-language semantic search query." }),
  ),
  limit: Schema.Int.check(Schema.isGreaterThan(0)).pipe(
    Schema.withDecodingDefault(Effect.succeed(5)),
    Schema.annotate({ description: "Maximum results to return. Defaults to 5." }),
  ),
  project: Schema.optional(Schema.String).pipe(
    Schema.annotate({ description: "Optional project scope for local Memo." }),
  ),
});
export type MemorySearchInput = typeof MemorySearchInput.Type;

export const MemoryRememberInput = Schema.Struct({
  connector: Connector,
  text: Schema.String.pipe(
    Schema.annotate({ description: "Self-contained memory text to store." }),
  ),
  source: Schema.optional(Schema.String).pipe(
    Schema.annotate({ description: "Optional source label for local Memo." }),
  ),
  project: Schema.optional(Schema.String).pipe(
    Schema.annotate({ description: "Optional project scope for local Memo." }),
  ),
});
export type MemoryRememberInput = typeof MemoryRememberInput.Type;

export const MemoryStatusInput = Schema.Struct({ connector: Connector });
export type MemoryStatusInput = typeof MemoryStatusInput.Type;

export const MemoryAttachmentSearchInput = Schema.Struct({
  connector: Connector,
  documentToken: Schema.String.pipe(
    Schema.annotate({ description: "Exact document token from a <memo_document> reference." }),
  ),
  query: Schema.String.check(Schema.isMinLength(1)).pipe(
    Schema.annotate({ description: "Keywords for the relevant passage inside this document." }),
  ),
  limit: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(12)).pipe(
    Schema.withDecodingDefault(Effect.succeed(4)),
    Schema.annotate({ description: "Maximum relevant chunks to return. Defaults to 4." }),
  ),
  project: Schema.optional(Schema.String).pipe(
    Schema.annotate({ description: "Project scope copied from the document reference." }),
  ),
});
export type MemoryAttachmentSearchInput = typeof MemoryAttachmentSearchInput.Type;

export const MemorySearchOutput = Schema.Struct({
  connector: Schema.Literal("local"),
  results: Schema.Array(MemoryEntry),
  count: Schema.Int,
});
export type MemorySearchOutput = typeof MemorySearchOutput.Type;

export const MemoryRememberOutput = Schema.Struct({
  connector: Schema.Literal("local"),
  id: Schema.optional(Schema.String),
  hash: Schema.optional(Schema.String),
  ok: Schema.Boolean,
});
export type MemoryRememberOutput = typeof MemoryRememberOutput.Type;

export const MemoryStatusOutput = Schema.Struct({
  connector: Schema.Literal("local"),
  count: Schema.optional(Schema.Number),
  backend: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  extra: Schema.optional(Schema.Unknown),
});
export type MemoryStatusOutput = typeof MemoryStatusOutput.Type;

export const MemoryAttachmentSearchOutput = Schema.Struct({
  connector: Schema.Literal("local"),
  documentToken: Schema.String,
  status: Schema.Literals(["ok", "missing", "incomplete"]),
  results: Schema.Array(MemoryEntry),
  count: Schema.Int,
});
export type MemoryAttachmentSearchOutput = typeof MemoryAttachmentSearchOutput.Type;

const readonlyMemoryTool = <T extends Tool.Any>(tool: T): T =>
  tool
    .annotate(Tool.OpenWorld, true)
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true) as T;

export const MemorySearchTool = readonlyMemoryTool(
  Tool.make("memory_search", {
    description:
      "Search local Memo semantic memory. This is an explicit read and never writes memory.",
    parameters: MemorySearchInput,
    success: MemorySearchOutput,
    failure: MemoryConnectorError,
    dependencies,
  }).annotate(Tool.Title, "Search memory"),
);

export const MemoryRememberTool = Tool.make("memory_remember", {
  description: "Explicitly store a self-contained memory in local Memo.",
  parameters: MemoryRememberInput,
  success: MemoryRememberOutput,
  failure: MemoryConnectorError,
  dependencies,
})
  .annotate(Tool.Title, "Remember")
  .annotate(Tool.OpenWorld, true)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const MemoryStatusTool = readonlyMemoryTool(
  Tool.make("memory_status", {
    description: "Check reachability and current status for local Memo.",
    parameters: MemoryStatusInput,
    success: MemoryStatusOutput,
    failure: MemoryConnectorError,
    dependencies,
  }).annotate(Tool.Title, "Memory status"),
);

export const MemoryAttachmentSearchTool = readonlyMemoryTool(
  Tool.make("memory_attachment_search", {
    description:
      "Search relevant chunks inside one complete local Memo document. Use the exact document token and project from <memo_document>; results cannot cross into another attachment.",
    parameters: MemoryAttachmentSearchInput,
    success: MemoryAttachmentSearchOutput,
    failure: MemoryConnectorError,
    dependencies,
  }).annotate(Tool.Title, "Search Memo document"),
);

export const MemoryToolkit = Toolkit.make(
  MemorySearchTool,
  MemoryRememberTool,
  MemoryStatusTool,
  MemoryAttachmentSearchTool,
);
