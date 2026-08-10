// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { JunieSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { checkJunieProviderStatus, junieModelsFromSessionSetup } from "./JunieProvider.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const decodeJunieSettings = Schema.decodeSync(JunieSettings);

/**
 * Shaped like a real `session/new` result from `junie --acp=true`: the catalog
 * lives in the model-category config option, and `models.availableModels` is
 * absent entirely. Reading that missing field is what left discovery empty and
 * fell back to a stale hardcoded list.
 */
const SESSION_CONFIG_OPTIONS = [
  {
    type: "select" as const,
    id: "model",
    name: "Model",
    category: "model" as const,
    currentValue: "gpt-5.6-terra",
    options: [
      { value: "claude-opus-5", name: "Claude Opus 5" },
      { value: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
      { value: "gpt-5.6-terra", name: "GPT-5.6-TERRA" },
      { value: "grok-4.5", name: "Grok 4.5" },
      { value: "custom:t3-local-ollama", name: "t3-local-ollama" },
    ],
  },
];

const models = (configOptions: unknown, modelConfigId: string | undefined) =>
  junieModelsFromSessionSetup(
    configOptions as Parameters<typeof junieModelsFromSessionSetup>[0],
    modelConfigId,
  );

it("reads the catalog Junie actually advertises", () => {
  const discovered = models(SESSION_CONFIG_OPTIONS, "model");
  NodeAssert.deepEqual(
    discovered.map((model) => model.slug),
    [
      "claude-opus-5",
      "gemini-3.1-pro-preview",
      "gpt-5.6-terra",
      "grok-4.5",
      "custom:t3-local-ollama",
    ],
  );
  NodeAssert.equal(discovered[1]?.name, "Gemini 3.1 Pro Preview");
});

it("marks `custom:` entries as custom so the UI can label them", () => {
  const discovered = models(SESSION_CONFIG_OPTIONS, "model");
  NodeAssert.equal(discovered.find((model) => model.slug === "grok-4.5")?.isCustom, false);
  NodeAssert.equal(
    discovered.find((model) => model.slug === "custom:t3-local-ollama")?.isCustom,
    true,
  );
});

it("flattens grouped options and drops duplicates", () => {
  const grouped = [
    {
      type: "select" as const,
      id: "model",
      name: "Model",
      category: "model" as const,
      currentValue: "a",
      options: [
        {
          name: "Hosted",
          options: [
            { value: "a", name: "A" },
            { value: "b", name: "B" },
          ],
        },
        { value: "b", name: "B duplicate" },
      ],
    },
  ];
  NodeAssert.deepEqual(
    models(grouped, "model").map((model) => model.slug),
    ["a", "b"],
  );
});

/**
 * Answers a `--version` probe itself, then hands the ACP handshake to the
 * shared mock agent pinned to Junie's model surface. Without the profile the
 * mock also sends Grok's `models.availableModels`, and this test would pass
 * against a provider reading either field.
 */
const makeJunieMockCli = async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "junie-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-junie.sh");
  const script = [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "Junie version: 26.7.27"; exit 0; fi',
    "export T3_ACP_MOCK_PROFILE=junie",
    `exec node ${JSON.stringify(mockAgentPath)} "$@"`,
    "",
  ].join("\n");
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
};

it.layer(NodeServices.layer)("checkJunieProviderStatus", (it) => {
  it.effect("discovers models from a successful handshake", () =>
    Effect.gen(function* () {
      const binaryPath = yield* Effect.promise(makeJunieMockCli);
      const snapshot = yield* checkJunieProviderStatus(
        decodeJunieSettings({ enabled: true, binaryPath }),
        process.env,
      );

      // The assertion the suite never made for Junie: the CLI answered, and
      // these slugs came from that answer, not from the fallback catalog.
      NodeAssert.equal(snapshot.status, "ready");
      NodeAssert.deepEqual(
        snapshot.models.map((model) => model.slug),
        [
          "default",
          "composer-2",
          "composer-2[fast=true]",
          "gpt-5.3-codex[reasoning=medium,fast=false]",
        ],
      );
    }),
  );
});

it("returns nothing when the session advertises no model option", () => {
  // The caller falls back to the hardcoded catalog on an empty result, so this
  // must stay empty rather than inventing entries.
  NodeAssert.deepEqual(models(SESSION_CONFIG_OPTIONS, undefined), []);
  NodeAssert.deepEqual(models([], "model"), []);
  NodeAssert.deepEqual(models(undefined, "model"), []);
});
