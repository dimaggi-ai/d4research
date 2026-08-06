import * as assert from "node:assert/strict";

import { it } from "@effect/vitest";

import { parseJunieCustomModelId } from "./JunieProvider.ts";

it("parses custom Junie model ids and ignores malformed files", () => {
  assert.equal(
    parseJunieCustomModelId('{"id":"gemma4-12b-sys:latest","baseUrl":"http://127.0.0.1:11434"}'),
    "gemma4-12b-sys:latest",
  );
  assert.equal(parseJunieCustomModelId('{"baseUrl":"http://x"}'), null);
  assert.equal(parseJunieCustomModelId("not json"), null);
  assert.equal(parseJunieCustomModelId('{"id":"   "}'), null);
});
