import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { codexAppServerArgs, codexExecLaunchArgs } from "./codexLaunchArgs.ts";

describe("codexAppServerArgs", () => {
  it("preserves escaped TOML quotes in config values", () => {
    NodeAssert.deepStrictEqual(
      codexAppServerArgs(String.raw`--config model=\"gpt-6.1-sol\" --strict-config`),
      ["app-server", "--config", 'model="gpt-6.1-sol"', "--strict-config"],
    );
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
