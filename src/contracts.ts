export const providerDrivers = ["mock", "ollama", "codex", "claude", "agy", "junie"] as const;
export type ProviderDriver = (typeof providerDrivers)[number];

export type ProviderConfig = {
  id: string;
  name: string;
  driver: ProviderDriver;
  model: string;
  endpoint: string;
  command: string;
  enabled: boolean;
};

export type ProviderHealth = {
  ok: boolean;
  message: string;
  models?: string[];
};

export type RunStatus =
  | "draft"
  | "planning"
  | "awaiting_approval"
  | "researching"
  | "synthesizing"
  | "auditing"
  | "completed"
  | "failed"
  | "cancelled";

export type ResearchRun = {
  id: string;
  title: string;
  question: string;
  status: RunStatus;
  activeProviderId: string;
  providerChainIds: string[];
  depth: "quick" | "deep" | "max";
  plan: ResearchPlan | null;
  report: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ResearchPlan = {
  objective: string;
  questions: string[];
  successCriteria: string[];
};

export type RunEvent = {
  id: number;
  runId: string;
  type: string;
  providerId: string | null;
  payload: unknown;
  createdAt: string;
};

export type RunMessage = {
  id: string;
  runId: string;
  role: "user" | "assistant";
  providerId: string | null;
  text: string;
  createdAt: string;
};

export type SourceRecord = {
  id: string;
  runId: string;
  url: string;
  title: string;
  excerpt: string;
  contentHash: string;
  retrievedAt: string;
};

export type CitationRecord = {
  id: string;
  runId: string;
  sourceId: string;
  claim: string;
  locator: string;
  createdAt: string;
};

export type ArtifactRecord = {
  id: string;
  runId: string;
  kind: "report" | "audit" | "evidence";
  content: string;
  contentHash: string;
  createdAt: string;
};

export type MemoryRecord = {
  id: string;
  runId: string | null;
  kind: "context" | "evidence" | "decision" | "handoff";
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type GenerateInput = {
  role: "planner" | "researcher" | "synthesizer" | "auditor" | "chat";
  prompt: string;
  cwd?: string;
};

export type GenerateResult = {
  text: string;
  sessionId?: string;
};

export type MemoryConnectorKind = "sqlite" | "memo" | "meko";

export type MemoryConnectorConfig = {
  id: string;
  name: string;
  kind: MemoryConnectorKind;
  url: string;
  enabled: boolean;
};

export function isProviderDriver(value: unknown): value is ProviderDriver {
  return typeof value === "string" && providerDrivers.includes(value as ProviderDriver);
}
