import type {
  ModelSelection,
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
} from "@d4research/contracts";
import { stripUserMessageTransport } from "@d4research/shared/userMessageTransport";

import type { ChatMessage } from "./types";

export interface ResearchMarkdownExportInput {
  readonly title: string;
  readonly project: string | null;
  readonly environmentId: string;
  readonly threadId: string;
  readonly modelSelection: ModelSelection;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly exportedAt: string;
}

function cleanLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}

function messageText(message: ChatMessage): string {
  if (message.role !== "user") return message.text.trim();
  const stripped = stripUserMessageTransport(message.text);
  const contextLabels = stripped.contexts.map((context) => context.label);
  if (contextLabels.length === 0) return stripped.promptText.trim();
  return `${stripped.promptText.trim()}\n\n_Attached context: ${contextLabels.join(", ")}_`;
}

function messageHeading(message: ChatMessage): string {
  const role =
    message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : "System";
  return `### ${role} · ${message.createdAt}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function researchManifestLines(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<string> {
  const activity = activities.findLast((candidate) => candidate.kind === "research.run.started");
  const payload = record(activity?.payload);
  if (payload === null) return ["_No controller-owned research run manifest was recorded._"];
  const scenario = typeof payload.scenario === "string" ? payload.scenario : "unknown";
  const pipelineHash = typeof payload.pipelineHash === "string" ? payload.pipelineHash : "unknown";
  const budget = record(payload.budget);
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const targets = Array.isArray(payload.targets) ? payload.targets : [];
  return [
    `- Scenario: \`${cleanLine(scenario)}\``,
    `- Pipeline SHA-256: \`${cleanLine(pipelineHash)}\``,
    `- Delegation budget: ${typeof budget?.maxDelegations === "number" ? budget.maxDelegations : "unknown"}`,
    `- Visit limit per step: ${typeof budget?.maxVisitsPerStep === "number" ? budget.maxVisitsPerStep : "unknown"}`,
    "",
    "### Planned steps",
    "",
    ...(steps.length > 0
      ? steps.flatMap((value) => {
          const step = record(value);
          if (step === null) return [];
          const number = typeof step.number === "number" ? step.number : "?";
          const title = typeof step.title === "string" ? cleanLine(step.title) : "Untitled";
          const delegation =
            step.delegation === "skipped-no-target"
              ? "delegate SKIPPED — no explicit target"
              : step.delegation === "planned"
                ? "delegation planned"
                : "local";
          return [`- Step ${number}: ${title} — ${delegation}`];
        })
      : ["_No numbered steps were parsed from the scenario._"]),
    "",
    "### Resolved delegate targets",
    "",
    ...(targets.length > 0
      ? targets.flatMap((value) => {
          const target = record(value);
          if (target === null) return [];
          const directive =
            typeof target.directive === "string" ? cleanLine(target.directive) : "unknown";
          if (target.status === "resolved" && typeof target.target === "string") {
            return [`- \`${directive}\` → \`${cleanLine(target.target)}\``];
          }
          return [
            `- \`${directive}\` → unresolved: ${typeof target.error === "string" ? cleanLine(target.error) : "unknown error"}`,
          ];
        })
      : ["_No delegate target was configured; delegate review is skipped._"]),
  ];
}

export function researchMarkdownFilename(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase()
    .slice(0, 72);
  return `${slug || "research-thread"}.md`;
}

export function buildResearchMarkdownExport(input: ResearchMarkdownExportInput): string {
  const latestAssistant = input.messages.findLast(
    (message) => message.role === "assistant" && message.text.trim().length > 0,
  );
  const relevantActivities = input.activities.filter(
    (activity) =>
      activity.kind.startsWith("research.") ||
      activity.kind.startsWith("provider.") ||
      activity.kind.startsWith("thread.turn"),
  );

  const lines = [
    `# ${cleanLine(input.title) || "Research thread"}`,
    "",
    "## Research result",
    "",
    latestAssistant?.text.trim() || "_No assistant result was recorded._",
    "",
    "## Run provenance",
    "",
    `- Project: ${input.project ? cleanLine(input.project) : "Unavailable"}`,
    `- Environment: \`${cleanLine(input.environmentId)}\``,
    `- Thread: \`${cleanLine(input.threadId)}\``,
    `- Current provider instance: \`${cleanLine(String(input.modelSelection.instanceId))}\``,
    `- Current model: \`${cleanLine(input.modelSelection.model)}\``,
    `- Latest turn state: ${input.latestTurn?.state ?? "none"}`,
    `- Exported: ${input.exportedAt}`,
    "",
    "## Research run manifest",
    "",
    ...researchManifestLines(input.activities),
    "",
    "## Authoritative conversation",
    "",
    ...input.messages.flatMap((message) => {
      const text = messageText(message);
      return [messageHeading(message), "", text || "_Empty message._", ""];
    }),
    "## Run events",
    "",
    ...(relevantActivities.length > 0
      ? relevantActivities.map(
          (activity) =>
            `- ${activity.createdAt} · \`${cleanLine(activity.kind)}\` — ${cleanLine(activity.summary)}`,
        )
      : ["_No research or provider lifecycle events were recorded._"]),
    "",
  ];

  return lines.join("\n");
}

export function downloadResearchMarkdown(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
