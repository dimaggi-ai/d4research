// A memory provider that answers in JSON under its own tool names, the way mem0's server does.
// The first argument picks another surface: "contract" for the provider-neutral memory_* tools,
// "meko" for Meko's tools.
import * as NodeReadline from "node:readline";

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const reply = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const stored = Array.from({ length: 25 }, (_, index) => ({
  id: `mem-${index}`,
  memory: `fact ${index}`,
  created_at: "2026-11-10T09:00:00Z",
  categories: ["work"],
}));

const mem0 = {
  list_entities: () => reply({ users: [] }),
  search_memories: (args) => reply({ results: stored.slice(0, args.limit), asked: args }),
  get_memories: (args) =>
    reply({ results: stored.slice((args.page - 1) * args.page_size, args.page * args.page_size) }),
  get_memory: (args) => reply({ id: args.memory_id, memory: "0123456789" }),
  add_memory: (args) => reply({ stored: args }),
  update_memory: (args) => reply({ updated: args }),
  delete_memory: () => ({ content: [{ type: "text", text: "no such memory" }], isError: true }),
};
const d4 = {
  memory_recall: (args) => ({
    content: [],
    structuredContent: {
      memories: [
        { id: "a", text: `${args.scope}:${args.query}`, date: "2026-11-10", category: "x" },
      ],
    },
  }),
  memory_add: (args) => ({ content: [{ type: "text", text: `stored ${args.text}` }] }),
  memory_search: () => ({
    content: [],
    structuredContent: {
      passages: [{ sourceId: "doc-1", start: 3, end: 9, title: "Doc", text: "body", date: null }],
    },
  }),
};
// Meko's tools refuse a call that does not name the conversation they opened.
let conversations = 0;
const inConversation = (args, value) =>
  args.conversation_id === "conv-1" && args.agent_id === "d4research"
    ? reply(value)
    : { content: [{ type: "text", text: "conversation_id required" }], isError: true };
const meko = {
  conversation_create: (args) =>
    reply({ id: `conv-${++conversations}`, datapack: args.datapack_id }),
  memory_search: (args) =>
    inConversation(args, {
      results: [{ id: "m1", memory: `${args.datapack_id}:${args.query}`, score: 0.5 }],
    }),
  context_search: (args) =>
    inConversation(args, {
      results: {
        memory: [],
        knowledge_base: [{ id: "c1", document_id: "doc-9", chunk_text: "chunk" }],
        conversation: { hits: [], thread: [] },
      },
    }),
  memory_get_by_id: (args) => inConversation(args, { id: args.memory_id, memory: "whole" }),
  memory_add: (args) => inConversation(args, { results: [{ id: "m2", memory: args.text }] }),
  memory_delete_by_id: (args) => inConversation(args, { deleted: args.memory_id }),
};
const tools = { contract: d4, meko }[process.argv[2]] ?? mem0;

NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-memory", version: "1.0.0" },
      },
    });
  } else if (method === "tools/list") {
    send({
      id,
      result: {
        tools: Object.keys(tools).map((name) => ({ name, inputSchema: { type: "object" } })),
      },
    });
  } else if (method === "tools/call" && tools[params.name]) {
    send({ id, result: tools[params.name](params.arguments) });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
});
