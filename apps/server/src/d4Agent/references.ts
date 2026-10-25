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
  new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped(value)}($|[^\\p{L}\\p{N}_-])`, "iu").test(text);

// Resolve identities before any provider turn. Titles are exact matches, never fuzzy context guesses.
export function resolveAgentReference(text: string, references: ReadonlyArray<AgentReference>) {
  const ids = references.filter((entry) => mentioned(text, entry.id));
  const candidates =
    ids.length > 0 ? ids : references.filter((entry) => mentioned(text, entry.title));
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
    (_match, kind: string, id: string, label: string | undefined) => {
      const target = references.find((entry) => entry.kind === kind && entry.id === id);
      const title = target?.title ?? label ?? id;
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
