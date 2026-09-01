import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { PipelinesToolkit } from "./tools.ts";

it("exports the complete agent pipeline API with object parameters", () => {
  expect(Object.keys(PipelinesToolkit.tools).sort()).toEqual([
    "pipeline_delete",
    "pipeline_get",
    "pipeline_list",
    "pipeline_upsert",
  ]);

  for (const tool of Object.values(PipelinesToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as { readonly type?: unknown };
    expect(schema.type, `${tool.name} must accept an object`).toBe("object");
    expect(tool.description?.length ?? 0).toBeGreaterThan(40);
  }
});
