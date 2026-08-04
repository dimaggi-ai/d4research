import type { ResearchPlan, ResearchRun } from "./contracts";
import { ResearchDatabase } from "./database";
import { generate, probeProvider } from "./providers";

function parsePlan(text: string, question: string): ResearchPlan {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (json) {
    try {
      const parsed = JSON.parse(json) as Partial<ResearchPlan>;
      if (
        typeof parsed.objective === "string" &&
        Array.isArray(parsed.questions) &&
        parsed.questions.every((entry) => typeof entry === "string") &&
        Array.isArray(parsed.successCriteria) &&
        parsed.successCriteria.every((entry) => typeof entry === "string")
      ) {
        return {
          objective: parsed.objective,
          questions: parsed.questions,
          successCriteria: parsed.successCriteria,
        };
      }
    } catch {
      // The fallback below keeps a provider formatting mistake recoverable.
    }
  }
  return {
    objective: question,
    questions: [question],
    successCriteria: ["Answer the question with cited evidence and explicit uncertainty."],
  };
}

export class ResearchOrchestrator {
  private readonly activeRuns = new Map<
    string,
    { controller: AbortController; completion: Promise<void> }
  >();

  constructor(private readonly database: ResearchDatabase) {}

  async plan(runId: string): Promise<ResearchRun> {
    const run = this.database.requireRun(runId);
    const provider = this.database.getProvider(run.activeProviderId);
    if (!provider) throw new Error(`Provider ${run.activeProviderId} was not found.`);
    const health = await probeProvider(provider);
    if (!health.ok) throw new Error(`Provider is unavailable: ${health.message}`);
    this.database.updateRun(runId, { status: "planning", error: null });
    this.database.addEvent(runId, "planning.started", provider.id, { depth: run.depth });
    try {
      const result = await generate(provider, {
        role: "planner",
        prompt: [
          "Create a research plan as JSON with exactly these fields:",
          '{"objective":"...","questions":["..."],"successCriteria":["..."]}',
          `Depth: ${run.depth}`,
          `Question: ${run.question}`,
          "Split independent lines of inquiry so workers can execute them concurrently.",
        ].join("\n"),
      });
      const plan = parsePlan(result.text, run.question);
      this.database.remember({
        runId,
        kind: "decision",
        content: JSON.stringify(plan),
        metadata: { stage: "plan", providerId: provider.id },
      });
      this.database.addEvent(runId, "plan.proposed", provider.id, plan);
      return this.database.updateRun(runId, { status: "awaiting_approval", plan });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.database.addEvent(runId, "planning.failed", provider.id, { message });
      return this.database.updateRun(runId, { status: "failed", error: message });
    }
  }

  execute(runId: string): void {
    if (this.activeRuns.has(runId)) throw new Error("This research run is already executing.");
    const run = this.database.requireRun(runId);
    if (!run.plan) throw new Error("Approve a generated plan before execution.");
    if (!["awaiting_approval", "failed"].includes(run.status)) {
      throw new Error(`Run cannot execute from status ${run.status}.`);
    }
    const controller = new AbortController();
    const completion = this.executeInBackground(runId, controller.signal).finally(() => {
      this.activeRuns.delete(runId);
    });
    this.activeRuns.set(runId, { controller, completion });
  }

  async waitForCompletion(runId: string): Promise<void> {
    await this.activeRuns.get(runId)?.completion;
  }

  cancel(runId: string): ResearchRun {
    this.activeRuns.get(runId)?.controller.abort();
    this.database.addEvent(runId, "run.cancelled", null, {});
    return this.database.updateRun(runId, { status: "cancelled" });
  }

  handoff(runId: string, targetProviderId: string): ResearchRun {
    const run = this.database.requireRun(runId);
    if (this.activeRuns.has(runId)) {
      throw new Error("Cancel or finish the current stage before changing providers.");
    }
    const target = this.database.getProvider(targetProviderId);
    if (!target?.enabled) throw new Error(`Target provider ${targetProviderId} is unavailable.`);
    const contextPacket = this.buildContextPacket(runId);
    this.database.remember({
      runId,
      kind: "handoff",
      content: contextPacket,
      metadata: { fromProviderId: run.activeProviderId, toProviderId: targetProviderId },
    });
    this.database.addEvent(runId, "provider.handoff", targetProviderId, {
      fromProviderId: run.activeProviderId,
      toProviderId: targetProviderId,
    });
    return this.database.updateRun(runId, { activeProviderId: targetProviderId });
  }

  buildContextPacket(runId: string): string {
    const run = this.database.requireRun(runId);
    const memories = this.database.searchMemory(
      `${run.question} ${run.plan?.objective ?? ""}`,
      runId,
      20,
    );
    return [
      `RUN: ${run.id}`,
      `GOAL: ${run.question}`,
      `STATUS: ${run.status}`,
      `PLAN: ${JSON.stringify(run.plan)}`,
      "SHARED MEMORY:",
      ...memories.map((memory) => `- [${memory.kind}] ${memory.content}`),
      "Continue this run. Do not restart completed work. Preserve source references and uncertainty.",
    ].join("\n\n");
  }

  async chat(runId: string, text: string): Promise<{ user: unknown; assistant: unknown }> {
    const run = this.database.requireRun(runId);
    if (this.activeRuns.has(runId)) {
      throw new Error("Wait for or cancel background research before starting a chat turn.");
    }
    const provider = this.database.getProvider(run.activeProviderId);
    if (!provider) throw new Error(`Provider ${run.activeProviderId} was not found.`);
    const health = await probeProvider(provider);
    if (!health.ok) throw new Error(`Provider is unavailable: ${health.message}`);
    const user = this.database.addMessage(runId, "user", null, text);
    const recentMessages = this.database.listMessages(runId).slice(-12);
    const result = await generate(provider, {
      role: "chat",
      prompt: [
        this.buildContextPacket(runId),
        "RECENT CHAT:",
        ...recentMessages.map((message) => `${message.role.toUpperCase()}: ${message.text}`),
        "Respond to the latest user message. Continue the existing run; do not restart it.",
      ].join("\n\n"),
    });
    const assistant = this.database.addMessage(runId, "assistant", provider.id, result.text);
    this.database.remember({
      runId,
      kind: "context",
      content: `USER: ${text}\n\nASSISTANT (${provider.id}): ${result.text}`,
      metadata: { stage: "chat", providerId: provider.id },
    });
    this.database.addEvent(runId, "chat.completed", provider.id, {
      userMessageId: user.id,
      assistantMessageId: assistant.id,
    });
    return { user, assistant };
  }

  private async executeInBackground(runId: string, signal: AbortSignal): Promise<void> {
    const initial = this.database.requireRun(runId);
    const provider = this.database.getProvider(initial.activeProviderId);
    if (!provider || !initial.plan) return;
    try {
      this.database.updateRun(runId, { status: "researching", error: null });
      this.database.addEvent(runId, "research.started", provider.id, {});
      const workerLimit = initial.depth === "quick" ? 2 : initial.depth === "deep" ? 4 : 6;
      const questions = initial.plan.questions.slice(0, workerLimit);
      const evidence = await Promise.all(
        questions.map(async (question, index) => {
          if (signal.aborted) throw new Error("Research was cancelled.");
          this.database.addEvent(runId, "worker.started", provider.id, { index, question });
          const result = await generate(provider, {
            role: "researcher",
            prompt: [
              `Research run goal: ${initial.question}`,
              `Assigned line of inquiry: ${question}`,
              "Return a concise evidence memo. Include URLs or source identifiers for every material claim.",
              "Separate direct evidence, inference, conflicts, and unknowns.",
            ].join("\n\n"),
          });
          this.database.remember({
            runId,
            kind: "evidence",
            content: result.text,
            metadata: { question, worker: index, providerId: provider.id },
          });
          this.database.addEvent(runId, "worker.completed", provider.id, { index, question });
          return result.text;
        }),
      );
      if (signal.aborted) throw new Error("Research was cancelled.");
      this.database.updateRun(runId, { status: "synthesizing" });
      this.database.addEvent(runId, "synthesis.started", provider.id, {});
      const synthesis = await generate(provider, {
        role: "synthesizer",
        prompt: [
          `Question: ${initial.question}`,
          `Approved plan: ${JSON.stringify(initial.plan)}`,
          "Evidence memos:",
          ...evidence.map((memo, index) => `\n--- MEMO ${index + 1} ---\n${memo}`),
          "Write a standalone report. Cite the supplied source URLs/identifiers next to claims. Do not invent citations. Explicitly identify conflicts and remaining uncertainty.",
        ].join("\n"),
      });
      if (signal.aborted) throw new Error("Research was cancelled.");
      this.database.updateRun(runId, { status: "auditing", report: synthesis.text });
      const audit = await generate(provider, {
        role: "auditor",
        prompt: [
          "Audit this report against the evidence memos.",
          "Flag unsupported claims, missing citations, source conflicts, and overconfident conclusions.",
          synthesis.text,
          ...evidence,
        ].join("\n\n"),
      });
      this.database.remember({
        runId,
        kind: "decision",
        content: audit.text,
        metadata: { stage: "citation-audit", providerId: provider.id },
      });
      this.database.addEvent(runId, "audit.completed", provider.id, { audit: audit.text });
      this.database.updateRun(runId, { status: "completed", report: synthesis.text });
    } catch (cause) {
      if (signal.aborted) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      this.database.addEvent(runId, "run.failed", provider.id, { message });
      this.database.updateRun(runId, { status: "failed", error: message });
    }
  }
}
