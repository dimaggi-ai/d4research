import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_NIA_MCP_SERVER_DRAFT,
  niaMcpServerDraft,
  niaMcpServerFromDraft,
} from "./niaServers.ts";

describe("Nia MCP server drafts", () => {
  it("parses a stdio server with one argument per line and KEY=value env", () => {
    const result = niaMcpServerFromDraft(
      {
        ...EMPTY_NIA_MCP_SERVER_DRAFT,
        name: "docs",
        command: " npx ",
        args: "-y\n\ndocs mcp\n",
        pairs: "TOKEN=a=b\n",
      },
      [],
    );
    expect(result).toEqual({
      server: {
        name: "docs",
        enabled: true,
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "docs mcp"],
          env: { TOKEN: "a=b" },
        },
      },
    });
    if ("server" in result)
      expect(niaMcpServerFromDraft(niaMcpServerDraft(result.server), [])).toEqual(result);
  });

  it("parses an HTTP server with Name: value headers and round-trips it", () => {
    const result = niaMcpServerFromDraft(
      {
        ...EMPTY_NIA_MCP_SERVER_DRAFT,
        name: "tracker",
        type: "http",
        url: "https://tracker.example/mcp",
        pairs: "Authorization: Bearer x:y",
      },
      [],
    );
    expect(result).toEqual({
      server: {
        name: "tracker",
        enabled: true,
        transport: {
          type: "http",
          url: "https://tracker.example/mcp",
          headers: { Authorization: "Bearer x:y" },
        },
      },
    });
    if ("server" in result)
      expect(niaMcpServerFromDraft(niaMcpServerDraft(result.server), [])).toEqual(result);
  });

  it("explains the first problem instead of saving", () => {
    const draft = { ...EMPTY_NIA_MCP_SERVER_DRAFT, name: "docs", command: "npx" };
    expect(niaMcpServerFromDraft({ ...draft, name: "t3-code" }, [])).toHaveProperty("error");
    expect(niaMcpServerFromDraft({ ...draft, name: "Docs" }, [])).toHaveProperty("error");
    expect(niaMcpServerFromDraft({ ...draft, command: " " }, [])).toHaveProperty("error");
    expect(niaMcpServerFromDraft({ ...draft, pairs: "novalue" }, [])).toHaveProperty("error");
    expect(niaMcpServerFromDraft({ ...draft, type: "http", url: "ftp://x" }, [])).toHaveProperty(
      "error",
    );
    const existing = niaMcpServerFromDraft(draft, []);
    if ("server" in existing)
      expect(niaMcpServerFromDraft(draft, [existing.server])).toEqual({
        error: "A server named docs already exists.",
      });
  });
});
