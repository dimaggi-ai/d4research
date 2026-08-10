import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  codexAppServerArgs,
  codexExecLaunchArgs,
  codexT3McpToolTimeoutArgs,
  resolveCodexLaunchArgs,
} from "./codexLaunchArgs.ts";

describe("resolveCodexLaunchArgs", () => {
  it("uses T3CODE_CODEX_LAUNCH_ARGS before configured settings", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "--enable foo" }),
      "--enable foo",
    );
  });

  it("uses configured settings when T3CODE_CODEX_LAUNCH_ARGS is empty", () => {
    NodeAssert.equal(
      resolveCodexLaunchArgs(" --strict-config ", { T3CODE_CODEX_LAUNCH_ARGS: "   " }),
      "--strict-config",
    );
  });

  it("ignores whitespace-only environment values", () => {
    NodeAssert.equal(resolveCodexLaunchArgs("", { T3CODE_CODEX_LAUNCH_ARGS: "   " }), "");
  });
});

describe("codexAppServerArgs", () => {
  it("returns the app-server command for empty launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("appends parsed launch args after app-server", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config --enable foo"), [
      "app-server",
      "--strict-config",
      "--enable",
      "foo",
    ]);
  });

  // `--search` is an exec/TUI flag that app-server rejects outright; the
  // equivalent is a config override. Without this, research delegates on Codex
  // answer from training data with no retrieval.
  it("enables web search as a config override, not --search", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("", true), [
      "app-server",
      "-c",
      "tools.web_search=true",
    ]);
  });

  it("omits the override when web search is off or unset", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("", false), ["app-server"]);
    NodeAssert.deepStrictEqual(codexAppServerArgs(""), ["app-server"]);
  });

  it("lets an explicit launch-arg override win over the setting", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("-c tools.web_search=false", true), [
      "app-server",
      "-c",
      "tools.web_search=false",
    ]);
  });

  it("keeps web search ahead of user launch args", () => {
    NodeAssert.deepStrictEqual(codexAppServerArgs("--strict-config", true), [
      "app-server",
      "-c",
      "tools.web_search=true",
      "--strict-config",
    ]);
  });
});

describe("codexExecLaunchArgs", () => {
  it("keeps shared codex flags and omits app-server-only flags", () => {
    NodeAssert.deepStrictEqual(
      codexExecLaunchArgs('--strict-config --enable foo --listen off --config model="gpt 5"'),
      ["--strict-config", "--enable", "foo", "--config", "model=gpt 5"],
    );
  });

  it("does not pair value-taking flags with adjacent flags", () => {
    NodeAssert.deepStrictEqual(codexExecLaunchArgs("--config --strict-config --enable --disable"), [
      "--strict-config",
    ]);
  });
});

describe("codexT3McpToolTimeoutArgs", () => {
  it("sets a timeout longer than the delegated-turn deadline", () => {
    NodeAssert.deepStrictEqual(codexT3McpToolTimeoutArgs("", 1_860), [
      "-c",
      "mcp_servers.t3-code.tool_timeout_sec=1860",
    ]);
  });

  it("lets every supported explicit config-argument form win", () => {
    for (const launchArgs of [
      "-c mcp_servers.t3-code.tool_timeout_sec=900",
      "-c=mcp_servers.t3-code.tool_timeout_sec=900",
      "--config mcp_servers.t3-code.tool_timeout_sec=900",
      "--config=mcp_servers.t3-code.tool_timeout_sec=900",
    ]) {
      NodeAssert.deepStrictEqual(codexT3McpToolTimeoutArgs(launchArgs, 1_860), []);
    }
  });
});
