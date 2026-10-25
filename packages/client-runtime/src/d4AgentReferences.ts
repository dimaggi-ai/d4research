import type {
  D4BrainContext,
  EnvironmentId,
  ProjectId,
  ServerSettings,
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
