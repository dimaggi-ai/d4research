import type {
  D4BrainContext,
  EnvironmentId,
  ProjectId,
  ServerSettings,
  ThreadId,
} from "@d4research/contracts";

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
      message: "You wrote this draft for an earlier Nia session.",
      reassignLabel: "Use in the current session",
    };
  return null;
}
