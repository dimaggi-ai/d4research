// Answers MCP over stdio with the plain-text replies Almanac's gateway sends.
import * as NodeReadline from "node:readline";

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const text = (value, isError = false) => ({ content: [{ type: "text", text: value }], isError });

const tools = {
  memory_browse: () => text("/work/ (2)"),
  knowledge_read: () => text("page://a 0-17/17\nline one\nline two"),
  memory_add: (args) => text(`created ${args.text}`),
  memory_forget: () => text("HTTP 403: refused", true),
};

NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    send({
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-almanac", version: "1.0.0" },
      },
    });
  } else if (method === "tools/call") {
    send({ id, result: tools[params.name](params.arguments) });
  } else {
    send({ id, error: { code: -32601, message: "Method not found" } });
  }
});
