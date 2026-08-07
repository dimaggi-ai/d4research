import { describe, expect, it } from "vite-plus/test";

import { expandResearchPipelinePrompt, type ResearchProviderCandidate } from "./researchPipeline";

/**
 * Live QA against a small local model (gemma4 via Ollama): does a modest
 * orchestrator actually obey the compiled protocol — step markers, delegation
 * through the tool, honesty about unresolved targets? Unit tests prove the
 * prompt says these things; this proves a mid model reads them the way we
 * intend. Skips cleanly when no Ollama daemon or no gemma4 tag is present, so
 * CI never depends on a local daemon.
 */
const OLLAMA_URL = "http://127.0.0.1:11434";
const GENERATION_TIMEOUT_MS = 150_000;

async function pickGemmaModel(): Promise<string | null> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { models?: Array<{ name?: string }> };
    const names = (payload.models ?? [])
      .map((model) => model.name)
      .filter((name): name is string => typeof name === "string");
    // 12B is the comprehension floor for the orchestrator protocol — the
    // e-class gemmas emit the step marker and then stall. Documenting that
    // floor is part of what this QA suite is for.
    return (
      names.find((name) => name === "gemma4:12b-it-qat") ??
      names.find((name) => /^gemma4:(?!e\d)/.test(name)) ??
      names.find((name) => name.startsWith("gemma4:")) ??
      null
    );
  } catch {
    return null;
  }
}

async function generateOnce(model: string, system: string, user: string): Promise<string> {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature: 0, num_ctx: 8_192 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Ollama responded ${response.status}`);
  const payload = (await response.json()) as { message?: { content?: string } };
  return payload.message?.content ?? "";
}

/**
 * Concurrent suites (this one and the server handoff QA) can force an Ollama
 * model reload mid-generation, returning a truncated reply. Retry a couple of
 * times on suspiciously short output — a genuinely incapable model still
 * produces the same short answer three times and fails the assertions.
 */
async function generate(model: string, system: string, user: string): Promise<string> {
  let reply = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    reply = await generateOnce(model, system, user);
    if (reply.trim().length >= 40) return reply;
  }
  return reply;
}

const CANDIDATES: ReadonlyArray<ResearchProviderCandidate> = [
  {
    instanceId: "claudeAgent",
    name: "Claude",
    cli: "claude",
    models: ["claude-fable-5", "claude-opus-5"],
  },
  { instanceId: "codex", name: "Codex", cli: "codex", models: ["gpt-5.6-terra"] },
];

describe("research pipeline QA (live gemma4)", () => {
  it(
    "a small orchestrator opens with the step marker and delegates via the tool",
    async () => {
      const model = await pickGemmaModel();
      if (!model) {
        console.log("SKIP research pipeline QA — no local Ollama daemon or gemma4 tag");
        return;
      }
      const briefing = expandResearchPipelinePrompt(
        "#deep-research Which is heavier, a liter of water or a liter of oil?",
        {
          scenarios: [],
          activeScenario: "",
          orchestratorSelection: null,
          pipelinePrompt:
            "Step 1: Delegate the research question to !claude:fable.\nStep 2: Summarize the delegate's answer for the user.",
          promptFiles: [],
        },
        CANDIDATES,
      );
      // No live tool harness exists over bare /api/chat, so the probe asks
      // the model to write out the call it would make. What we verify is
      // comprehension of the briefing: the marker discipline and the
      // directive → resolved-target mapping.
      const reply = await generate(
        model,
        briefing,
        "Begin executing the pipeline now. First state your current step marker. Then write out the exact research_delegate tool call you would make, including the target argument copied exactly from the Delegation targets list. Do not simulate results you do not have.",
      );
      // Trace discipline: the protocol demands a `[step N | visit K]` marker.
      expect(reply).toMatch(/\[\s*step\s*1/i);
      // Delegation discipline: the call names the tool and carries the exact
      // resolved target — not the raw `!` directive.
      expect(reply).toMatch(/research[_ ]delegate/i);
      expect(reply).toContain("claudeAgent:claude-fable-5");
    },
    GENERATION_TIMEOUT_MS + 10_000,
  );

  it(
    "a small orchestrator reports an unresolved directive instead of substituting",
    async () => {
      const model = await pickGemmaModel();
      if (!model) {
        console.log("SKIP research pipeline QA — no local Ollama daemon or gemma4 tag");
        return;
      }
      const briefing = expandResearchPipelinePrompt(
        "#deep-research What color is the sky?",
        {
          scenarios: [],
          activeScenario: "",
          orchestratorSelection: null,
          pipelinePrompt: "Step 1: Delegate the question to !gemini:pro and report its answer.",
          promptFiles: [],
        },
        CANDIDATES,
      );
      const reply = await generate(
        model,
        briefing,
        "Begin executing the pipeline now. First state your current step marker. Then state your first action. Do not simulate results you do not have.",
      );
      // The briefing marks the target UNRESOLVED and orders it surfaced to the
      // user. The model must name the broken directive, and must not silently
      // reroute the call to a provider the pipeline never named.
      expect(reply.toLowerCase()).toContain("gemini");
      expect(reply).not.toContain("claudeAgent:claude-fable-5");
      expect(reply).not.toContain("codex:gpt-5.6-terra");
    },
    GENERATION_TIMEOUT_MS + 10_000,
  );
});
