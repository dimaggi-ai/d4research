import type {
  GenerateInput,
  GenerateResult,
  ProviderConfig,
  ProviderHealth,
} from "./contracts";

const PROBE_TIMEOUT_MS = 5_000;
const GENERATE_TIMEOUT_MS = 10 * 60_000;

function cleanEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runCommand(
  command: string,
  args: string[],
  input: string | null,
  cwd: string | undefined,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([command, ...args], {
    ...(cwd ? { cwd } : {}),
    stdin: input === null ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  if (input !== null && child.stdin) {
    child.stdin.write(input);
    child.stdin.end();
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut) throw new Error(`Command exceeded ${Math.round(timeoutMs / 1_000)} seconds.`);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function commandArgs(provider: ProviderConfig, input: GenerateInput): {
  args: string[];
  stdin: string | null;
} {
  const modelArgs = provider.model ? ["--model", provider.model] : [];
  switch (provider.driver) {
    case "codex":
      return {
        args: ["exec", "--skip-git-repo-check", "--json", ...modelArgs, "-"],
        stdin: input.prompt,
      };
    case "claude":
      return {
        args: ["-p", input.prompt, "--output-format", "json", ...modelArgs],
        stdin: null,
      };
    case "agy":
      return {
        args: ["--print", input.prompt, "--output-format", "json", "--print-timeout", "10m", ...modelArgs],
        stdin: null,
      };
    case "junie":
      return {
        args: [
          `--task=First use a read-only shell command to print the current working directory. Do not modify files. Then complete this task and return its requested artifact in the final result:\n\n${input.prompt}`,
          "--output-format=json",
          "--skip-update-check",
          "--mcp-default-locations=false",
          "--command-default-location=false",
          ...(provider.model ? [`--model=${provider.model}`] : []),
        ],
        stdin: null,
      };
    default:
      throw new Error(`Driver ${provider.driver} is not a CLI provider.`);
  }
}

function extractJsonText(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ["result", "text", "content", "message", "response"]) {
      if (typeof parsed[key] === "string") return parsed[key];
    }
  } catch {
    // Some CLIs emit JSONL. Inspect each event below, then retain plain output as fallback.
  }
  let lastText = "";
  for (const line of trimmed.split("\n")) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const item = event.item as Record<string, unknown> | undefined;
      const candidate = event.result ?? event.text ?? event.content ?? item?.text;
      if (typeof candidate === "string" && candidate.trim()) lastText = candidate;
    } catch {
      // Ignore non-JSON diagnostics; the complete stdout remains the fallback.
    }
  }
  return lastText || trimmed;
}

function mockGenerate(input: GenerateInput): GenerateResult {
  if (input.role === "planner") {
    return {
      text: JSON.stringify({
        objective: "Produce an evidence-backed answer to the research question.",
        questions: [
          "What primary evidence directly addresses the question?",
          "Which credible sources disagree, and why?",
          "What conclusions remain uncertain?",
        ],
        successCriteria: [
          "Every material claim has a source reference.",
          "Conflicting evidence is represented.",
          "The report separates facts, inference, and uncertainty.",
        ],
      }),
    };
  }
  if (input.role === "auditor") {
    return { text: "AUDIT PASS: structure, uncertainty, and citation placeholders are present." };
  }
  if (input.role === "researcher") {
    return { text: `Evidence note generated from the assigned question.\n\n${input.prompt.slice(0, 500)}` };
  }
  if (input.role === "chat") {
    return { text: "Shared-context chat reply from the active provider." };
  }
  return {
    text: [
      "# Research report",
      "",
      "This deterministic report proves the complete local orchestration path.",
      "",
      "## Findings",
      "",
      "The configured workers completed planning, parallel evidence collection, synthesis, and audit.",
      "",
      "## Limitations",
      "",
      "The QA provider does not access external sources; production providers must supply cited evidence.",
    ].join("\n"),
  };
}

export async function probeProvider(provider: ProviderConfig): Promise<ProviderHealth> {
  if (!provider.enabled) return { ok: false, message: "Provider is disabled." };
  if (provider.driver === "mock") return { ok: true, message: "Deterministic local provider ready." };
  if (provider.driver === "ollama") {
    try {
      const response = await fetchWithTimeout(`${cleanEndpoint(provider.endpoint)}/api/tags`);
      if (!response.ok) return { ok: false, message: `Ollama returned HTTP ${response.status}.` };
      const body = (await response.json()) as { models?: Array<{ name?: string }> };
      const models = (body.models ?? []).flatMap((model) => (model.name ? [model.name] : []));
      return {
        ok: provider.model ? models.includes(provider.model) : true,
        message:
          provider.model && !models.includes(provider.model)
            ? `Connected, but model ${provider.model} is not installed.`
            : `Connected to Ollama with ${models.length} models.`,
        models,
      };
    } catch (cause) {
      return { ok: false, message: `Ollama probe failed: ${errorMessage(cause)}` };
    }
  }
  try {
    const command = provider.command || provider.driver;
    const versionFlag = provider.driver === "junie" ? "--version" : "--version";
    const result = await runCommand(command, [versionFlag], null, undefined, PROBE_TIMEOUT_MS);
    const detail = (result.stdout || result.stderr).trim().split("\n")[0] ?? "";
    return result.exitCode === 0
      ? { ok: true, message: detail || `${provider.driver} is executable.` }
      : { ok: false, message: detail || `${provider.driver} exited ${result.exitCode}.` };
  } catch (cause) {
    return { ok: false, message: `${provider.driver} probe failed: ${errorMessage(cause)}` };
  }
}

export async function generate(
  provider: ProviderConfig,
  input: GenerateInput,
): Promise<GenerateResult> {
  if (!provider.enabled) throw new Error(`Provider ${provider.name} is disabled.`);
  if (provider.driver === "mock") return mockGenerate(input);
  if (provider.driver === "ollama") {
    const response = await fetchWithTimeout(
      `${cleanEndpoint(provider.endpoint)}/api/chat`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: provider.model,
          stream: false,
          messages: [
            {
              role: "system",
              content:
                "You are a worker in a durable research system. Preserve citations, distinguish evidence from inference, and return only the requested artifact.",
            },
            { role: "user", content: input.prompt },
          ],
        }),
      },
      GENERATE_TIMEOUT_MS,
    );
    if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as { message?: { content?: string } };
    const text = body.message?.content?.trim();
    if (!text) throw new Error("Ollama returned no message content.");
    return { text };
  }
  const command = provider.command || provider.driver;
  const invocation = commandArgs(provider, input);
  const result = await runCommand(command, invocation.args, invocation.stdin, input.cwd, GENERATE_TIMEOUT_MS);
  const text = extractJsonText(result.stdout);
  if (result.exitCode !== 0) {
    // Junie can emit a complete structured result and then fail while shutting
    // down an optional external integration. Preserve the completed agent result
    // while still rejecting exits that produced no usable artifact.
    if (provider.driver === "junie" && text) return { text };
    throw new Error(`${provider.driver} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  if (!text) throw new Error(`${provider.driver} returned no output.`);
  return { text };
}
