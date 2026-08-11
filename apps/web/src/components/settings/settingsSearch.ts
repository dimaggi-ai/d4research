export type SettingsPath =
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/source-control"
  | "/settings/research"
  | "/settings/dev-pipelines"
  | "/settings/connections"
  | "/settings/tool-guard"
  | "/settings/skills"
  | "/settings/archived";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
}

/**
 * Section labels in sidebar order. The sidebar nav and the search-result
 * subtitles both render from this record, so each label exists once.
 */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/general": "General",
  "/settings/appearance": "Appearance",
  "/settings/keybindings": "Keybindings",
  "/settings/providers": "Providers",
  "/settings/source-control": "Source Control",
  "/settings/research": "Research",
  "/settings/dev-pipelines": "Dev pipelines",
  "/settings/connections": "Connections",
  "/settings/tool-guard": "Tool Guard",
  "/settings/skills": "Skills",
  "/settings/archived": "Archive",
};

/**
 * Every searchable setting, in result order. This catalog is the single
 * source of truth for anchor ids and visible titles: panels render both via
 * `searchableSetting`, so a retitle (or, later, a translation pass) happens
 * here once instead of separately in the panel and the index.
 */
export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "theme",
    title: "Theme",
    to: "/settings/appearance",
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    title: "Glass opacity",
    to: "/settings/appearance",
  },
  {
    id: "environment-identification",
    title: "Environment identification",
    to: "/settings/appearance",
    // The setting is stage-dependent, so its parent section is the stable destination.
    targetId: "appearance",
  },
  {
    id: "interface-font",
    title: "Interface font",
    to: "/settings/appearance",
  },
  {
    id: "prompt-font",
    title: "Prompt font",
    to: "/settings/appearance",
  },
  {
    id: "code-font",
    title: "Code font",
    to: "/settings/appearance",
  },
  {
    id: "terminal-font",
    title: "Terminal font",
    to: "/settings/appearance",
  },
  {
    id: "font-smoothing",
    title: "Font smoothing",
    to: "/settings/appearance",
  },
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/appearance",
  },
  {
    id: "project-grouping",
    title: "Project grouping",
    to: "/settings/general",
  },
  {
    id: "time-format",
    title: "Time format",
    to: "/settings/general",
  },
  {
    id: "hide-whitespace-changes",
    title: "Hide whitespace changes",
    to: "/settings/general",
  },
  {
    id: "assistant-output",
    title: "Assistant output",
    to: "/settings/general",
  },
  {
    id: "auto-resume-usage-limit",
    title: "Resume after usage limits",
    to: "/settings/general",
  },
  {
    id: "provider-update-checks",
    title: "Provider update checks",
    to: "/settings/general",
  },
  {
    id: "new-threads",
    title: "New threads",
    to: "/settings/general",
  },
  {
    id: "start-from-origin",
    title: "Start from origin",
    to: "/settings/general",
    targetId: "new-threads",
  },
  {
    id: "add-project-starts-in",
    title: "Add project starts in",
    to: "/settings/general",
  },
  {
    id: "archive-confirmation",
    title: "Archive confirmation",
    to: "/settings/general",
  },
  {
    id: "delete-confirmation",
    title: "Delete confirmation",
    to: "/settings/general",
  },
  {
    id: "text-generation-model",
    title: "Text generation model",
    to: "/settings/general",
  },
  {
    id: "handoff",
    title: "Handoff",
    to: "/settings/general",
  },
  {
    id: "handoff-context-compression",
    title: "Context compression",
    to: "/settings/general",
    targetId: "handoff",
  },
  {
    id: "research-pipeline",
    title: "Research",
    to: "/settings/research",
  },
  {
    id: "research-scenario",
    title: "Research scenarios",
    to: "/settings/research",
    targetId: "research-pipeline",
  },
  {
    id: "research-pipeline-prompt",
    title: "Pipeline",
    to: "/settings/research",
    targetId: "research-pipeline",
  },
  {
    id: "research-prompt-files",
    title: "Prompt files",
    to: "/settings/research",
    targetId: "research-pipeline",
  },
  {
    id: "research-context",
    title: "Research context",
    to: "/settings/research",
    targetId: "research-pipeline",
  },
  {
    id: "dev-pipelines",
    title: "Dev pipelines",
    to: "/settings/dev-pipelines",
  },
  {
    id: "dev-pipeline-scenario",
    title: "Dev pipeline",
    to: "/settings/dev-pipelines",
    targetId: "dev-pipelines",
  },
  {
    id: "dev-pipeline-prompt",
    title: "Pipeline steps",
    to: "/settings/dev-pipelines",
    targetId: "dev-pipelines",
  },
  {
    id: "dev-pipeline-prompt-files",
    title: "Dev pipeline prompt files",
    to: "/settings/dev-pipelines",
    targetId: "dev-pipelines",
  },
  {
    id: "tool-guard-policies",
    title: "Tool Guard policies",
    to: "/settings/tool-guard",
  },
  {
    id: "skills-enabled-default",
    title: "Global skills",
    to: "/settings/skills",
  },
  {
    id: "skills-inventory",
    title: "Skills",
    to: "/settings/skills",
  },
  {
    id: "keybindings",
    title: "Keybindings",
    to: "/settings/keybindings",
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
  },
  {
    id: "source-control",
    title: "Source control",
    to: "/settings/source-control",
  },
  {
    id: "remote-environments",
    title: "Remote environments",
    to: "/settings/connections",
  },
  {
    id: "archive",
    title: "Archived threads",
    to: "/settings/archived",
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = Object.fromEntries(
  SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item]),
) as Readonly<Record<SettingsSearchItemId, SettingsSearchItem>>;

/**
 * `id` and `title` props for the element a search item anchors to. Panels
 * spread (or pick from) this instead of restating the strings, so the catalog
 * and the rendered settings cannot drift apart.
 */
export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID[id];
  return { id: anchorId, title };
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];

  return items.filter((item) => normalizeSearchText(item.title).includes(normalizedQuery));
}
