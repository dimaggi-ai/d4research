import {
  type D4BrainContext,
  type EnvironmentId,
  type ProjectId,
  type ServerSettings,
  ThreadId,
} from "@d4research/contracts";
import { formatThreadLink } from "@d4research/shared/threadLinks";

export interface AgentMention {
  readonly kind: "thread" | "project" | "pipeline";
  readonly id: string;
  readonly title: string;
}

export function agentMentionQuery(text: string) {
  return /(?:^|\s)@([^@\n]*)$/.exec(text)?.[1] ?? null;
}

export function insertAgentMention(text: string, mention: AgentMention) {
  return text.replace(
    /(^|\s)@[^@\n]*$/,
    (_match, space: string) => `${space}[[${mention.kind}:${mention.id}]] `,
  );
}

export function agentMentionOptions(input: {
  environmentId: EnvironmentId;
  context: D4BrainContext;
  agentProjectId: ProjectId | null;
  settings: Pick<ServerSettings, "d4Agent" | "dev" | "research"> | undefined;
  projects: ReadonlyArray<{
    id: ProjectId;
    title: string;
    environmentId: EnvironmentId;
    deletedAt?: string | null;
  }>;
  threads: ReadonlyArray<{
    id: string;
    projectId: ProjectId;
    title: string;
    environmentId: EnvironmentId;
    archivedAt: string | null;
    deletedAt: string | null;
  }>;
  query: string | null;
}): ReadonlyArray<AgentMention> {
  if (input.query === null || !input.settings) return [];
  const settings = input.settings;
  const inScope = (projectId: ProjectId) =>
    input.context === "Global" || settings.d4Agent.projectContexts[projectId] === input.context;
  const projects = input.projects.filter(
    (project) =>
      project.environmentId === input.environmentId &&
      project.id !== input.agentProjectId &&
      !project.deletedAt &&
      inScope(project.id),
  );
  const projectIds = new Set<string>(projects.map((project) => project.id));
  const options: AgentMention[] = [
    ...input.threads
      .filter(
        (thread) =>
          thread.environmentId === input.environmentId &&
          projectIds.has(thread.projectId) &&
          !thread.archivedAt &&
          !thread.deletedAt,
      )
      .map((thread) => ({ kind: "thread" as const, id: thread.id, title: thread.title })),
    ...projects.map((project) => ({
      kind: "project" as const,
      id: project.id,
      title: project.title,
    })),
    ...(["dev", "research"] as const).flatMap((kind) =>
      (settings[kind]?.scenarios ?? []).flatMap((pipeline) => {
        const id = `${kind}:${pipeline.name}`;
        const projectId = settings.d4Agent.pipelineProjects?.[id];
        return input.context === "Global" || (projectId !== undefined && projectIds.has(projectId))
          ? [{ kind: "pipeline" as const, id, title: pipeline.name }]
          : [];
      }),
    ),
  ];
  const query = input.query.toLocaleLowerCase();
  return options
    .filter(
      (option) =>
        option.title.toLocaleLowerCase().includes(query) ||
        option.id.toLocaleLowerCase().includes(query),
    )
    .slice(0, 12);
}

/** The Nia context and session a draft was written for. */
export interface AgentDraftOrigin {
  readonly context: D4BrainContext;
  readonly threadId: ThreadId | null;
}

interface AgentDraftTarget {
  readonly brainContext: D4BrainContext;
  readonly threadId: ThreadId | null;
}

export const agentDraftOrigin = (state: AgentDraftTarget): AgentDraftOrigin => ({
  context: state.brainContext,
  threadId: state.threadId,
});

/**
 * A draft stays bound to the context and session it was written for. When Nia has moved on, the
 * user must reassign the draft before sending, so its text never lands in another context
 * unnoticed.
 */
export function agentDraftMovedNotice(
  origin: AgentDraftOrigin | null,
  state: AgentDraftTarget,
): { readonly message: string; readonly reassignLabel: string } | null {
  if (origin === null) return null;
  if (origin.context !== state.brainContext)
    return {
      message: `You wrote this draft while Nia was in ${origin.context}. Nia is now in ${state.brainContext}.`,
      reassignLabel: `Use in ${state.brainContext}`,
    };
  // Opening or closing a session in the same context is not a move; replacing one is.
  if (origin.threadId !== null && state.threadId !== null && origin.threadId !== state.threadId)
    return {
      message: "You wrote this draft in an earlier Nia session.",
      reassignLabel: "Use in the current session",
    };
  return null;
}

export type NiaTextSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "url"; readonly text: string; readonly href: string }
  | { readonly kind: "thread"; readonly text: string; readonly threadId: ThreadId };

const niaLinkPattern = /\[\[thread:([^|\]]+)\|([^\]]+)\]\]|https?:\/\/[^\s<>"'`]+/g;

// Splits server-authored Nia system text into plain text, web links and thread links. A thread
// token links only when the server validated it into `links`; anything else stays text.
export function niaSystemTextSegments(
  text: string,
  links: ReadonlyArray<{ readonly threadId: ThreadId | null }>,
): ReadonlyArray<NiaTextSegment> {
  const segments: NiaTextSegment[] = [];
  const pushText = (value: string) => {
    if (value.length === 0) return;
    const last = segments.at(-1);
    if (last?.kind === "text")
      segments[segments.length - 1] = { kind: "text", text: last.text + value };
    else segments.push({ kind: "text", text: value });
  };
  let cursor = 0;
  for (const match of text.matchAll(niaLinkPattern)) {
    pushText(text.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const [token, threadId, label] = match;
    if (threadId !== undefined && label !== undefined) {
      const known = links.find((link) => link.threadId === threadId)?.threadId;
      if (known == null) pushText(label);
      else segments.push({ kind: "thread", text: label, threadId: known });
      continue;
    }
    // Sentence punctuation after a URL is not part of it.
    const href = token.replace(/[.,;:!?)\]'"]+$/, "");
    cursor -= token.length - href.length;
    segments.push({ kind: "url", text: href, href });
  }
  pushText(text.slice(cursor));
  return segments;
}

// Code comes first so references inside code stay literal; written links and autolinks are kept,
// except a markdown link whose web URL opens a thread.
const niaThreadReferencePattern =
  /(?<fence>(`{3,}|~{3,})[\s\S]*?(?:\2|$))|(?<span>(`+)[^\n]*?\4)|\[(?<label>[^\]\n]*)\]\((?<href>[^\s)]+)\)|(?<autolink><[^\s<>]+>)|(?<url>https?:\/\/[^\s<>"'`]+)|(?<![\w:/.-])(?<id>[A-Za-z0-9][\w:-]*[A-Za-z0-9])(?![\w:/-])/g;

const NIA_ACTION_THREAD_PREFIX = "d4-action:";

/**
 * Rewrites the thread references Nia writes as prose into `t3-thread` links, so the chat shows
 * them as thread chips: `d4-action:` ids, ids of threads `knownThreadIds` holds, and web URLs
 * that open a thread of `environmentId`. Unknown references keep a short id as their label.
 */
export function niaThreadReferenceMarkdown(
  text: string,
  environmentId: EnvironmentId,
  knownThreadIds: ReadonlySet<string>,
): string {
  const isThread = (id: string) =>
    knownThreadIds.has(id) || id.startsWith(NIA_ACTION_THREAD_PREFIX);
  const link = (threadId: string, label?: string) =>
    formatThreadLink(
      { environmentId, threadId: ThreadId.make(threadId) },
      label?.trim() || shortThreadLabel(threadId),
    );
  const urlThreadId = (href: string) => {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    const [environment, threadId, ...rest] = url.pathname.split("/").filter(Boolean);
    if (rest.length > 0 || environment === undefined || threadId === undefined) return null;
    try {
      const decoded = decodeURIComponent(threadId);
      return decodeURIComponent(environment) === environmentId && isThread(decoded)
        ? decoded
        : null;
    } catch {
      return null;
    }
  };
  return text.replace(niaThreadReferencePattern, (source, ...args) => {
    const groups = args.at(-1) as Record<string, string | undefined>;
    if (groups.href !== undefined) {
      const threadId = urlThreadId(groups.href);
      return threadId === null ? source : link(threadId, groups.label);
    }
    if (groups.url !== undefined) {
      // Sentence punctuation after a URL is not part of it.
      const href = groups.url.replace(/[.,;:!?)\]'"]+$/, "");
      const threadId = urlThreadId(href);
      return threadId === null ? source : link(threadId) + groups.url.slice(href.length);
    }
    if (groups.id !== undefined && isThread(groups.id)) return link(groups.id);
    return source;
  });
}

function shortThreadLabel(threadId: string) {
  const id = threadId.startsWith(NIA_ACTION_THREAD_PREFIX)
    ? threadId.slice(NIA_ACTION_THREAD_PREFIX.length)
    : threadId;
  return `Thread ${id.slice(0, 8)}`;
}
