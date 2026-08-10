import { describe, expect, it } from "vite-plus/test";

import { replaceNamedPipelinePromptFiles } from "./DevPipelinesSettingsPanel";

const pipelines = [
  { name: "one", pipelinePrompt: "one", promptFiles: [] },
  { name: "two", pipelinePrompt: "two", promptFiles: [] },
];

describe("replaceNamedPipelinePromptFiles", () => {
  it("updates the pipeline that started the async read without changing another pipeline", () => {
    expect(
      replaceNamedPipelinePromptFiles(pipelines, "one", [
        { name: "rules.md", content: "Keep it small." },
      ]),
    ).toEqual([
      {
        name: "one",
        pipelinePrompt: "one",
        promptFiles: [{ name: "rules.md", content: "Keep it small." }],
      },
      pipelines[1],
    ]);
  });

  it("does not revive a pipeline deleted while its file read was pending", () => {
    expect(
      replaceNamedPipelinePromptFiles([pipelines[1]!], "one", [
        { name: "rules.md", content: "stale" },
      ]),
    ).toBeNull();
  });
});
