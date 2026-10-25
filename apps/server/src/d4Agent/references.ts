import {
  ProjectId,
  type D4AgentSettings,
  type D4BrainContext,
  type ThreadId,
} from "@d4research/contracts";
import { projectContentInScope } from "./brainScope.ts";

export interface AgentReference {
  readonly kind: "thread" | "project" | "pipeline";
  readonly id: string;
  readonly title: string;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId | null;
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentioned = (text: string, value: string) =>
  value.length > 0 &&
  new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped(value)}($|[^\\p{L}\\p{N}_-])`, "u").test(text);

// Only explicit identities may select a context; titles are untrusted display metadata.
// Pipeline ids are user-chosen names (e.g. `dev:web`) that collide with ordinary text,
// so pipelines resolve only through the picker token; raw ids match threads and projects.
export function resolveAgentReference(text: string, references: ReadonlyArray<AgentReference>) {
  const tokens = [...text.matchAll(/\[\[(thread|project|pipeline):([^\]]+)\]\]/g)];
  const unmarked = text.replace(/\[\[[^\]]*\]\]/g, "");
  const candidates = references.filter(
    (entry) =>
      tokens.some((match) => match[1] === entry.kind && match[2] === entry.id) ||
      (entry.kind !== "pipeline" && mentioned(unmarked, entry.id)),
  );
  const unique = [
    ...new Map(candidates.map((entry) => [`${entry.kind}:${entry.id}`, entry])).values(),
  ];
  if (unique.length === 0) return { kind: "none" as const };
  if (unique.length > 1) return { kind: "ambiguous" as const, candidates: unique };
  return { kind: "resolved" as const, target: unique[0]! };
}

export const referenceContext = (
  reference: AgentReference,
  config: D4AgentSettings,
): D4BrainContext =>
  reference.projectId === null
    ? "Global"
    : (config.projectContexts[reference.projectId] ?? "Global");

export function validateReplyReferences(
  text: string,
  references: ReadonlyArray<AgentReference>,
  context: D4BrainContext,
  config: D4AgentSettings,
) {
  const links: Array<{ label: string; threadId: ThreadId | null; projectId: ProjectId | null }> =
    [];
  const rendered = text.replace(
    /\[\[(thread|project):([^|\]]+)(?:\|([^\]]+))?\]\]/g,
    (_match, kind: string, id: string) => {
      const target = references.find((entry) => entry.kind === kind && entry.id === id);
      const metadataAllowed =
        target !== undefined &&
        (context === "Global" || referenceContext(target, config) === context);
      const title = metadataAllowed ? target.title : "Unavailable reference";
      const allowed =
        target?.projectId != null && projectContentInScope(context, config, target.projectId);
      links.push({
        label: title,
        threadId: allowed ? target.threadId : null,
        projectId: allowed ? target.projectId : null,
      });
      return title;
    },
  );
  return { text: rendered, links };
}
