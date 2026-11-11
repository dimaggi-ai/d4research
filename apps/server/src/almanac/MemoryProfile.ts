import type {
  AlmanacMemory,
  AlmanacPassage,
  AlmanacReadResult,
  AlmanacRecallResult,
  AlmanacSearchResult,
} from "@d4research/contracts";

/**
 * Memory providers share no MCP convention: tool names, argument names and
 * reply shapes all differ. A profile maps the server's eight memory operations
 * onto one provider's tools, as data, so a new provider needs no code.
 */

/** Dot-separated keys into a JSON reply; of several candidates the first one present wins. "" is the reply itself. */
export type Path = string | ReadonlyArray<string>;

/**
 * Tool arguments. A string value that is exactly "$name" is replaced by that variable;
 * the key is left out when the variable has no value. Variables: query, limit, text, id,
 * path, offset, page, pageSize, start, maxChars, scope, title.
 */
export type Template = { readonly [key: string]: unknown };

export interface Call {
  readonly tool: string;
  readonly args: Template;
}
export interface MemoryList {
  readonly items: Path;
  readonly id?: Path;
  readonly text: Path;
  readonly date?: Path;
  readonly category?: Path;
}
export interface PassageList {
  readonly items: Path;
  readonly sourceId: Path;
  readonly text: Path;
  readonly title?: Path;
  readonly date?: Path;
  readonly start?: Path;
  readonly end?: Path;
}
export interface MemoryProfile {
  readonly name: string;
  /** The provider is recognized when its tool list holds all of these. */
  readonly detect: ReadonlyArray<string>;
  /**
   * For a provider whose tools need a session: called once per connection,
   * and the id in its reply is the variable "session" from then on.
   */
  readonly session?: Call & { readonly id: Path };
  readonly status?: Call;
  readonly recall?: Call & { readonly memories: MemoryList };
  readonly browse?: Call & { readonly memories: MemoryList; readonly pageSize: number };
  readonly search?: Call & { readonly passages: PassageList };
  /** windowed: the provider applies start and maxChars itself. Otherwise the whole text is cut here. */
  readonly read?: Call & {
    readonly content: Path;
    readonly uri?: Path;
    readonly total?: Path;
    readonly windowed?: boolean;
  };
  readonly add?: Call;
  readonly update?: Call;
  readonly forget?: Call;
}

export type Vars = { readonly [name: string]: string | number | undefined };

export const fill = (template: unknown, vars: Vars): unknown => {
  if (typeof template === "string") {
    if (!template.startsWith("$") || !(template.slice(1) in vars)) return template;
    const value = vars[template.slice(1)];
    return value === "" ? undefined : value;
  }
  if (Array.isArray(template)) {
    const filled = template.map((item) => fill(item, vars)).filter((item) => item !== undefined);
    // A list that named only absent variables is left out, like an absent value.
    return template.length > 0 && filled.length === 0 ? undefined : filled;
  }
  if (template && typeof template === "object") {
    const filled: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template)) {
      const next = fill(value, vars);
      if (next !== undefined && next !== "") filled[key] = next;
    }
    return filled;
  }
  return template;
};

export const pick = (value: unknown, path: Path | undefined): unknown => {
  if (path === undefined) return undefined;
  for (const candidate of typeof path === "string" ? [path] : path) {
    let current = value;
    for (const key of candidate === "" ? [] : candidate.split(".")) {
      current =
        current && typeof current === "object"
          ? (current as Record<string, unknown>)[key]
          : undefined;
    }
    if (current !== undefined && current !== null) return current;
  }
  return undefined;
};

const asText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(asText).join("\n");
  return typeof value === "object" ? JSON.stringify(value) : String(value);
};
const asInt = (value: unknown) => (Number.isInteger(value) ? (value as number) : 0);
const asDay = (value: unknown) =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;

/** A tool result as the MCP SDK returns it. */
export interface Reply {
  readonly structuredContent?: unknown;
  readonly content?: unknown;
}

export const prose = (reply: Reply): string =>
  (Array.isArray(reply.content) ? reply.content : [])
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("\n");

/** Structured content when the provider sends it, otherwise JSON found in the text. */
export const json = (reply: Reply): unknown => {
  if (reply.structuredContent && typeof reply.structuredContent === "object")
    return reply.structuredContent;
  try {
    return JSON.parse(prose(reply));
  } catch {
    return undefined;
  }
};

const memories = (data: unknown, shape: MemoryList): Array<AlmanacMemory> | null => {
  const items = pick(data, shape.items);
  if (!Array.isArray(items)) return null;
  return items.flatMap((item) => {
    const text = typeof item === "string" ? item : asText(pick(item, shape.text));
    if (!text) return [];
    const category = asText(pick(item, shape.category));
    return [
      {
        id: asText(pick(item, shape.id)),
        date: asDay(pick(item, shape.date)),
        text,
        category: category || null,
        replacedBy: null,
      },
    ];
  });
};

const READ_LIMIT = 8000;

export const readRecall = (
  reply: Reply,
  shape: MemoryList,
  proseAllowed = true,
): AlmanacRecallResult | null => {
  const data = json(reply);
  const found = memories(data, shape);
  if (found) return { memories: found };
  if (data !== undefined || !proseAllowed) return null;
  // Some providers answer in prose. One unnamed memory keeps the answer usable.
  const text = prose(reply).trim();
  if (!text) return { memories: [] };
  return {
    memories: [
      { id: "", date: null, text: text.slice(0, READ_LIMIT), category: null, replacedBy: null },
    ],
  };
};

export const readSearch = (reply: Reply, shape: PassageList): AlmanacSearchResult | null => {
  const items = pick(json(reply), shape.items);
  if (!Array.isArray(items)) return null;
  const passages: Array<AlmanacPassage> = items.flatMap((item) => {
    const sourceId = asText(pick(item, shape.sourceId));
    if (!sourceId) return [];
    return [
      {
        sourceId,
        start: asInt(pick(item, shape.start)),
        end: asInt(pick(item, shape.end)),
        date: asDay(pick(item, shape.date)),
        title: asText(pick(item, shape.title)),
        text: asText(pick(item, shape.text)),
      },
    ];
  });
  return { passages, indexingIncomplete: false };
};

export const readSource = (
  reply: Reply,
  shape: NonNullable<MemoryProfile["read"]>,
  sourceId: string,
  start: number,
  maxChars: number,
): AlmanacReadResult | null => {
  const data = json(reply);
  const whole = data === undefined ? prose(reply) : asText(pick(data, shape.content));
  if (!whole && data !== undefined && pick(data, shape.content) === undefined) return null;
  const uri = asText(pick(data, shape.uri)) || sourceId;
  if (shape.windowed) {
    const end = start + whole.length;
    const total = pick(data, shape.total);
    return {
      uri,
      start,
      end,
      total: Number.isInteger(total) ? (total as number) : end,
      content: whole,
    };
  }
  const content = whole.slice(start, start + maxChars);
  return { uri, start, end: start + content.length, total: whole.length, content };
};

/** The provider-neutral contract: a memory server that offers these tools needs no profile. */
const D4: MemoryProfile = {
  name: "d4",
  detect: ["memory_recall", "memory_add"],
  recall: {
    tool: "memory_recall",
    args: { query: "$query", limit: "$limit", scope: "$scope" },
    memories: { items: "memories", id: "id", text: "text", date: "date", category: "category" },
  },
  browse: {
    tool: "memory_browse",
    args: { path: "$path", offset: "$offset", scope: "$scope" },
    pageSize: 20,
    memories: { items: "memories", id: "id", text: "text", date: "date", category: "category" },
  },
  search: {
    tool: "memory_search",
    args: { query: "$query", limit: "$limit", scope: "$scope" },
    passages: {
      items: "passages",
      sourceId: "sourceId",
      text: "text",
      title: "title",
      date: "date",
      start: "start",
      end: "end",
    },
  },
  read: {
    tool: "memory_read",
    args: { sourceId: "$id", start: "$start", maxChars: "$maxChars", scope: "$scope" },
    content: "content",
    uri: "uri",
    total: "total",
    windowed: true,
  },
  add: { tool: "memory_add", args: { text: "$text", scope: "$scope" } },
  update: { tool: "memory_update", args: { id: "$id", text: "$text", scope: "$scope" } },
  forget: { tool: "memory_forget", args: { id: "$id", scope: "$scope" } },
};

/** Kumbuka replies in bounded plain text, which AlmanacText parses; only its name and tools are data. */
export const KUMBUKA: MemoryProfile = { name: "kumbuka", detect: ["kumbuka_search"] };

// Tool and argument names below were read from each provider's server source on 2026-11-10.
const MEM0_MEMORIES: MemoryList = {
  items: ["results", "memories", ""],
  id: "id",
  text: ["memory", "text"],
  date: ["created_at", "updated_at"],
  category: "categories.0",
};
const MEM0: MemoryProfile = {
  name: "mem0",
  detect: ["search_memories", "add_memory", "delete_memory"],
  status: { tool: "list_entities", args: {} },
  recall: {
    tool: "search_memories",
    args: { query: "$query", limit: "$limit" },
    memories: MEM0_MEMORIES,
  },
  browse: {
    tool: "get_memories",
    args: { page: "$page", page_size: "$pageSize" },
    pageSize: 20,
    memories: MEM0_MEMORIES,
  },
  read: { tool: "get_memory", args: { memory_id: "$id" }, content: ["memory", "text"] },
  add: { tool: "add_memory", args: { text: "$text", user_id: "$scope" } },
  update: { tool: "update_memory", args: { memory_id: "$id", text: "$text" } },
  forget: { tool: "delete_memory", args: { memory_id: "$id" } },
};

/** OpenMemory offers no single-item update or delete over MCP. */
const OPENMEMORY: MemoryProfile = {
  name: "openmemory",
  detect: ["add_memories", "search_memory", "list_memories"],
  recall: {
    tool: "search_memory",
    args: { query: "$query" },
    memories: { items: "", id: "id", text: "memory", date: "created_at" },
  },
  browse: {
    tool: "list_memories",
    args: {},
    pageSize: 1000,
    memories: { items: "", id: "id", text: "memory", date: "created_at" },
  },
  add: { tool: "add_memories", args: { text: "$text" } },
};

/** Graphiti keeps facts as graph edges; it has no update, and a fact is forgotten by its edge id. */
const GRAPHITI: MemoryProfile = {
  name: "graphiti",
  detect: ["search_memory_facts", "add_memory", "get_episodes"],
  status: { tool: "get_status", args: {} },
  recall: {
    tool: "search_memory_facts",
    args: { query: "$query", max_facts: "$limit", group_ids: ["$scope"] },
    memories: {
      items: "facts",
      id: "uuid",
      text: "fact",
      date: ["valid_at", "created_at"],
      category: "name",
    },
  },
  browse: {
    tool: "get_episodes",
    args: { max_episodes: "$pageSize", group_ids: ["$scope"] },
    pageSize: 100,
    memories: {
      items: "episodes",
      id: "uuid",
      text: ["content", "name"],
      date: "created_at",
      category: "source_description",
    },
  },
  add: {
    tool: "add_memory",
    args: { name: "$title", episode_body: "$text", group_id: "$scope" },
  },
  forget: { tool: "delete_entity_edge", args: { uuid: "$id" } },
};

/** The MCP reference server: a memory is an entity, named by its first words. */
const SERVER_MEMORY: MemoryProfile = {
  name: "server-memory",
  detect: ["create_entities", "search_nodes", "open_nodes"],
  recall: {
    tool: "search_nodes",
    args: { query: "$query", limit: "$limit" },
    memories: { items: "entities", id: "name", text: "observations", category: "entityType" },
  },
  browse: {
    tool: "read_graph",
    args: {},
    pageSize: 1000,
    memories: { items: "entities", id: "name", text: "observations", category: "entityType" },
  },
  read: { tool: "open_nodes", args: { names: ["$id"] }, content: "entities.0.observations" },
  add: {
    tool: "create_entities",
    args: { entities: [{ name: "$title", entityType: "memory", observations: ["$text"] }] },
  },
  forget: { tool: "delete_entities", args: { entityNames: ["$id"] } },
};

/** Supermemory forgets by content, not by id, and has no update by id, so both stay off. */
const SUPERMEMORY: MemoryProfile = {
  name: "supermemory",
  detect: ["search_memory", "get_profile", "add_memory"],
  status: { tool: "who_am_i", args: {} },
  recall: {
    tool: "search_memory",
    args: { informationToGet: "$query", limit: "$limit", containerTag: "$scope" },
    memories: {
      items: "results",
      id: "documentId",
      text: ["chunks.0.content", "content", "summary"],
      date: "createdAt",
      category: "type",
    },
  },
  search: {
    tool: "search_memory",
    args: { informationToGet: "$query", limit: "$limit", containerTag: "$scope" },
    passages: {
      items: "results",
      sourceId: "documentId",
      text: ["chunks.0.content", "content", "summary"],
      title: "title",
      date: "createdAt",
    },
  },
  read: {
    tool: "get_document",
    args: { documentId: "$id" },
    content: ["content", "document.content"],
  },
  add: { tool: "add_memory", args: { thingToRemember: "$text", containerTag: "$scope" } },
};

/** Cognee answers recall in prose or JSON by search type; its forget needs a dataset, so it stays off. */
const COGNEE: MemoryProfile = {
  name: "cognee",
  detect: ["remember", "recall", "cognify_status"],
  status: { tool: "cognify_status", args: {} },
  recall: {
    tool: "recall",
    args: { query: "$query", top_k: "$limit", datasets: ["$scope"] },
    memories: { items: ["results", ""], id: "id", text: ["text", "content"] },
  },
  add: { tool: "remember", args: { data: "$text", dataset_name: "$scope" } },
};

/**
 * Meko (tool contract of its official skill, release 2.6.1). Every call names a conversation,
 * so one is created per connection. The scope is the datapack; empty means the default one.
 * Documents are found through context_search; Meko has no tool that returns a whole document.
 */
const MEKO_ARGS = { conversation_id: "$session", agent_id: "d4research", datapack_id: "$scope" };
const MEKO_MEMORIES: MemoryList = {
  items: ["results", "memories", ""],
  id: "id",
  text: ["memory", "text"],
  date: ["created_at", "updated_at"],
};
const MEKO: MemoryProfile = {
  name: "meko",
  detect: ["context_search", "memory_search", "memory_get_by_id"],
  session: {
    tool: "conversation_create",
    args: { agent_id: "d4research", title: "d4 memory", datapack_id: "$scope" },
    id: ["id", "conversation_id"],
  },
  recall: {
    tool: "memory_search",
    args: { query: "$query", limit: "$limit", ...MEKO_ARGS },
    memories: MEKO_MEMORIES,
  },
  browse: {
    tool: "memory_get_all",
    args: { page: "$page", page_size: "$pageSize", ...MEKO_ARGS },
    pageSize: 20,
    memories: MEKO_MEMORIES,
  },
  search: {
    tool: "context_search",
    args: { query: "$query", limit: "$limit", ...MEKO_ARGS },
    passages: {
      items: "results.knowledge_base",
      sourceId: ["document_id", "id"],
      text: "chunk_text",
      title: ["filename", "title", "document_name"],
      date: "created_at",
    },
  },
  read: {
    tool: "memory_get_by_id",
    args: { memory_id: "$id", ...MEKO_ARGS },
    content: ["memory", "text", "result.memory", "results.0.memory"],
  },
  add: { tool: "memory_add", args: { text: "$text", ...MEKO_ARGS } },
  update: { tool: "memory_update", args: { memory_id: "$id", text: "$text", ...MEKO_ARGS } },
  forget: { tool: "memory_delete_by_id", args: { memory_id: "$id", ...MEKO_ARGS } },
};

/** Most specific first: several providers share names such as add_memory. */
export const PROFILES: ReadonlyArray<MemoryProfile> = [
  KUMBUKA,
  MEKO,
  D4,
  SUPERMEMORY,
  MEM0,
  OPENMEMORY,
  GRAPHITI,
  SERVER_MEMORY,
  COGNEE,
];

/** False for a tool that takes no page or offset: it returns everything at once. */
export const takesPosition = (call: Call): boolean =>
  /"\$(page|offset)"/.test(JSON.stringify(call.args));

export const detectProfile = (tools: ReadonlyArray<string>): MemoryProfile | null =>
  PROFILES.find((profile) => profile.detect.every((name) => tools.includes(name))) ?? null;

const isCall = (value: unknown): value is Call =>
  !!value &&
  typeof value === "object" &&
  typeof (value as Call).tool === "string" &&
  !!(value as Call).args &&
  typeof (value as Call).args === "object";

/** A profile written by the user as JSON, for a provider that has no built-in one. */
export const parseProfile = (source: string): MemoryProfile | null => {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const profile = value as Record<string, unknown>;
  for (const operation of [
    "session",
    "status",
    "recall",
    "browse",
    "search",
    "read",
    "add",
    "update",
    "forget",
  ])
    if (profile[operation] !== undefined && !isCall(profile[operation])) return null;
  const list = (operation: string, key: string) =>
    profile[operation] === undefined ||
    typeof (profile[operation] as Record<string, unknown>)[key] === "object";
  if (!list("recall", "memories") || !list("browse", "memories") || !list("search", "passages"))
    return null;
  if (
    profile.session !== undefined &&
    (profile.session as Record<string, unknown>).id === undefined
  )
    return null;
  if (profile.read !== undefined && (profile.read as Record<string, unknown>).content === undefined)
    return null;
  return {
    ...(profile as unknown as MemoryProfile),
    name: typeof profile.name === "string" ? profile.name : "custom",
    detect: [],
    ...(profile.browse
      ? {
          browse: {
            ...(profile.browse as NonNullable<MemoryProfile["browse"]>),
            pageSize: asInt((profile.browse as { pageSize?: unknown }).pageSize) || 20,
          },
        }
      : {}),
  };
};
