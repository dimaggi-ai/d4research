import { describe, expect, it } from "vite-plus/test";

import type { D4AgentMcpServer } from "@d4research/contracts";

import {
  EMPTY_NIA_MCP_SERVER_DRAFT,
  NIA_MCP_HIDDEN_VALUE,
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
          env: [{ name: "TOKEN", value: "a=b" }],
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
          headers: [{ name: "Authorization", value: "Bearer x:y" }],
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

  it("keeps hidden values only when the user leaves them in place on the same server", () => {
    const saved: D4AgentMcpServer = {
      name: "docs",
      enabled: true,
      transport: {
        type: "stdio",
        command: "npx",
        args: [],
        env: [
          { name: "TOKEN", value: "", valueRedacted: true },
          { name: "MODE", value: "fast" },
        ],
      },
    };
    const draft = niaMcpServerDraft(saved);
    expect(draft.pairs).toBe(`TOKEN=${NIA_MCP_HIDDEN_VALUE}\nMODE=fast`);
    expect(niaMcpServerFromDraft(draft, [], saved)).toEqual({ server: saved });
    expect(
      niaMcpServerFromDraft({ ...draft, pairs: "TOKEN=new\nMODE=fast" }, [], saved),
    ).toMatchObject({
      server: { transport: { env: [{ name: "TOKEN", value: "new" }, { name: "MODE" }] } },
    });
    expect(niaMcpServerFromDraft({ ...draft, name: "docs2" }, [], saved)).toEqual({
      error: "Enter a value for TOKEN.",
    });
    expect(niaMcpServerFromDraft(draft, [])).toEqual({ error: "Enter a value for TOKEN." });
  });
});
