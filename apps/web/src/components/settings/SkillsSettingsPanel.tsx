import { useEffect, useMemo, useState } from "react";
import { DownloadIcon, Link2Icon, SearchIcon, Share2Icon } from "lucide-react";
import { ENABLED_BY_DEFAULT_SKILL_MAX_COUNT } from "@d4research/contracts";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironment } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  useSkillsInventory,
  type SkillsInventoryAgent,
  type SkillsInventoryEntry,
  type SkillsInventoryRoot,
} from "../../hooks/useSkillsInventory";

const ROOT_ORDER: ReadonlyArray<SkillsInventoryRoot> = [
  "project",
  "claude-user",
  "codex-user",
  "junie-user",
  "agy-user",
];

const ROOT_LABELS: Readonly<Record<SkillsInventoryRoot, string>> = {
  project: "Project",
  "claude-user": "Claude (user)",
  "codex-user": "Shared (user)",
  "junie-user": "Junie (user)",
  "agy-user": "Agy (user)",
};

const ROOT_DESCRIPTIONS: Readonly<Record<SkillsInventoryRoot, string>> = {
  project: "Workspace skills under .agents/skills and .claude/skills.",
  "claude-user": "Skills under ~/.claude/skills, including category subdirectories.",
  "codex-user":
    "Skills under ~/.agents/skills, read natively by Codex, Cursor, Grok, and OpenCode; includes Codex's bundled .system set.",
  "junie-user": "Skills under ~/.junie/skills and commands under ~/.junie/commands.",
  "agy-user": "Skills registered in ~/.gemini/config/skills.json.",
};

const AGENT_LABELS: Readonly<Record<SkillsInventoryAgent, string>> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
  junie: "Junie",
  agy: "Agy",
  all: "All agents",
};

function Badge({ children, tone }: { children: string; tone: "scope" | "agent" | "link" }) {
  const toneClass =
    tone === "scope"
      ? "bg-muted text-muted-foreground"
      : tone === "agent"
        ? "bg-primary/10 text-primary"
        : "bg-amber-500/10 text-amber-600 dark:text-amber-400";
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${toneClass}`}
    >
      {children}
    </span>
  );
}

export function canEnableSkillForAllChats(
  entry: Pick<SkillsInventoryEntry, "kind" | "scope">,
): boolean {
  return entry.kind === "skill" && entry.scope === "user";
}

function SkillRow({
  entry,
  sharing,
  onShare,
  enabledByDefault,
  defaultEnableDisabled,
  onToggleDefault,
}: {
  readonly entry: SkillsInventoryEntry;
  readonly sharing: string | null;
  readonly onShare: (sourcePath: string, targetRoot: SkillsInventoryRoot) => void;
  readonly enabledByDefault: boolean;
  readonly defaultEnableDisabled: boolean;
  readonly onToggleDefault: (name: string, enabled: boolean) => void;
}) {
  // Sharing a skill into the root it already lives in is a no-op the server
  // rejects, so it never appears as a choice.
  const shareTargets = ROOT_ORDER.filter((root) => root !== entry.root);
  const [target, setTarget] = useState<SkillsInventoryRoot>(shareTargets[0] ?? "claude-user");
  const isSharing = sharing === `${entry.path}:${target}`;

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card px-3 py-2.5 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">{entry.name}</span>
          <Badge tone="scope">{entry.kind === "command" ? "Command" : entry.scope}</Badge>
          {entry.agents.map((agent) => (
            <Badge key={agent} tone="agent">
              {AGENT_LABELS[agent]}
            </Badge>
          ))}
          {entry.isSymlinked ? <Badge tone="link">Linked</Badge> : null}
        </div>
        {entry.description ? (
          <p className="text-xs text-muted-foreground">{entry.description}</p>
        ) : null}
        <p className="truncate font-mono text-[11px] text-muted-foreground/60" title={entry.path}>
          {entry.isSymlinked ? (
            <Link2Icon className="mr-1 inline size-3 align-[-1px]" aria-hidden />
          ) : null}
          {entry.path}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {canEnableSkillForAllChats(entry) ? (
          <label className="mr-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
            All chats
            <Switch
              checked={enabledByDefault}
              disabled={defaultEnableDisabled}
              onCheckedChange={(checked) => onToggleDefault(entry.name, Boolean(checked))}
              aria-label={`Enable ${entry.name} globally for all chats`}
            />
          </label>
        ) : null}
        <Select
          value={target}
          onValueChange={(value) => {
            if (shareTargets.includes(value as SkillsInventoryRoot)) {
              setTarget(value as SkillsInventoryRoot);
            }
          }}
        >
          <SelectTrigger className="h-7 w-40" aria-label={`Share target for ${entry.name}`}>
            <SelectValue>{ROOT_LABELS[target]}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {shareTargets.map((root) => (
              <SelectItem key={root} value={root}>
                {ROOT_LABELS[root]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          size="xs"
          variant="outline"
          disabled={sharing !== null}
          aria-label={`Share ${entry.name}`}
          onClick={() => onShare(entry.path, target)}
        >
          <Share2Icon className="mr-1 size-3" />
          {isSharing ? "Sharing…" : "Share"}
        </Button>
      </div>
    </div>
  );
}

export function SkillsSettingsPanel() {
  // Settings routes have no active thread route. Select an environment-local
  // project explicitly instead of silently scanning the server's own cwd.
  const primaryEnvironment = usePrimaryEnvironment();
  const projects = useProjects();
  const projectOptions = useMemo(
    () =>
      projects.filter(
        (project) =>
          project.environmentId === primaryEnvironment?.environmentId && project.workspaceRoot,
      ),
    [primaryEnvironment?.environmentId, projects],
  );
  const [selectedProjectId, setSelectedProjectId] = useState("");
  useEffect(() => {
    if (projectOptions.some((project) => project.id === selectedProjectId)) return;
    setSelectedProjectId(String(projectOptions[0]?.id ?? ""));
  }, [projectOptions, selectedProjectId]);
  const selectedProject = projectOptions.find(
    (project) => String(project.id) === selectedProjectId,
  );
  const preparedConnectionOption = usePreparedConnection(primaryEnvironment?.environmentId ?? null);
  const preparedConnection =
    preparedConnectionOption._tag === "Some" ? preparedConnectionOption.value : null;
  const inventory = useSkillsInventory(selectedProject?.workspaceRoot, {
    preparedConnection,
  });
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const [query, setQuery] = useState("");
  const [installUrl, setInstallUrl] = useState("");
  const [installAgyPlugin, setInstallAgyPlugin] = useState(false);
  const [installMessage, setInstallMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [savingDefaultName, setSavingDefaultName] = useState<string | null>(null);
  const [defaultSaveError, setDefaultSaveError] = useState<string | null>(null);

  const runInstall = async () => {
    const url = installUrl.trim();
    if (url.length === 0 || inventory.installing) return;
    setInstallMessage(null);
    const result = await inventory.install(url, { installAgyPlugin });
    setInstallMessage({ ok: result.ok, text: result.message });
    if (result.ok) {
      setInstallUrl("");
      setInstallAgyPlugin(false);
    }
  };

  const grouped = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matches = needle
      ? inventory.entries.filter((entry) =>
          [entry.name, entry.description ?? "", entry.path].some((field) =>
            field.toLocaleLowerCase().includes(needle),
          ),
        )
      : inventory.entries;
    return ROOT_ORDER.map((root) => ({
      root,
      entries: matches.filter((entry) => entry.root === root),
    }));
  }, [inventory.entries, query]);

  const hasMatches = grouped.some((group) => group.entries.length > 0);
  const enabledByDefault = settings.skills.enabledByDefault;
  const enabledByDefaultSet = useMemo(() => new Set(enabledByDefault), [enabledByDefault]);
  const availableSkillNames = useMemo(
    () =>
      new Set(
        inventory.entries.filter((entry) => entry.kind === "skill").map((entry) => entry.name),
      ),
    [inventory.entries],
  );
  const missingEnabledNames = enabledByDefault.filter((name) => !availableSkillNames.has(name));
  const chatsWithSessionSkills = Object.keys(settings.skills.enabledByThread).length;

  const toggleDefault = async (name: string, enabled: boolean) => {
    if (savingDefaultName !== null) return;
    setSavingDefaultName(name);
    setDefaultSaveError(null);
    try {
      await updateSettings({ skills: { setEnabledByDefault: { name, enabled } } });
    } catch (error) {
      setDefaultSaveError(error instanceof Error ? error.message : "Could not save global skills.");
    } finally {
      setSavingDefaultName(null);
    }
  };

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("skills-enabled-default")}>
        <p className="px-1 text-xs text-muted-foreground">
          Global skills are attached to every turn in every chat and survive provider handoffs. Each
          one consumes context because the receiving agent reads its SKILL.md before acting.
        </p>
        {defaultSaveError ? (
          <p className="px-1 text-xs text-destructive">{defaultSaveError}</p>
        ) : null}
        <p className="px-1 text-xs text-muted-foreground">
          {enabledByDefault.length} of {ENABLED_BY_DEFAULT_SKILL_MAX_COUNT} global skills enabled.
          Use the All chats switch below. Add chat-only skills from the Skills control in a
          composer; {chatsWithSessionSkills} chat{chatsWithSessionSkills === 1 ? "" : "s"} currently
          ha{chatsWithSessionSkills === 1 ? "s" : "ve"} chat-specific skills.
        </p>
        {missingEnabledNames.length > 0 ? (
          <div className="space-y-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
            <p className="text-xs text-muted-foreground">
              These configured skills are missing in this environment and will not be attached:
            </p>
            <div className="flex flex-wrap gap-1.5">
              {missingEnabledNames.map((name) => (
                <Button
                  key={name}
                  size="xs"
                  variant="outline"
                  aria-label={`Disable missing default skill ${name}`}
                  onClick={() => void toggleDefault(name, false)}
                >
                  {name} · Disable
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection {...searchableSetting("skills-inventory")}>
        <p className="px-1 text-xs text-muted-foreground">
          Every skill and command the local agents can see. User skills installed by d4research are
          automatically shared across compatible coding CLIs; existing conflicts are never
          overwritten.
        </p>
        {projectOptions.length > 0 ? (
          <div className="flex items-center justify-between gap-3 rounded-md border px-2 py-1.5">
            <span className="text-xs text-muted-foreground">Project skills workspace</span>
            <Select
              value={selectedProjectId}
              onValueChange={(value) => {
                if (value !== null) setSelectedProjectId(value);
              }}
            >
              <SelectTrigger className="h-7 min-w-48" aria-label="Skills project">
                <SelectValue>
                  {selectedProject?.title ?? selectedProject?.workspaceRoot ?? "Select project"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {projectOptions.map((project) => (
                  <SelectItem key={project.id} value={String(project.id)}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : null}
        <div className="flex items-center gap-2 rounded-md border px-2 py-1.5">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            nativeInput
            unstyled
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Filter skills by name, description, or path"
            aria-label="Filter skills"
            className="min-w-0 flex-1"
          />
        </div>
        <div className="flex items-center gap-2 rounded-md border px-2 py-1.5">
          <DownloadIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Input
            nativeInput
            unstyled
            type="url"
            value={installUrl}
            onChange={(event) => setInstallUrl(event.currentTarget.value)}
            placeholder="Install from a git URL, e.g. https://github.com/owner/skill-repo"
            aria-label="Skill repository URL"
            className="min-w-0 flex-1"
          />
          <Button
            size="xs"
            variant="outline"
            disabled={installUrl.trim().length === 0 || inventory.installing}
            onClick={() => void runInstall()}
          >
            {inventory.installing ? "Installing…" : "Install"}
          </Button>
        </div>
        <label className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
          <Switch
            checked={installAgyPlugin}
            onCheckedChange={(checked) => setInstallAgyPlugin(Boolean(checked))}
            aria-label="Also install the Agy plugin package"
          />
          <span>
            Also install the Agy plugin package. This grants the repository's hooks and MCP servers,
            not only its portable skill instructions.
          </span>
        </label>
        {installMessage ? (
          <p
            className={
              installMessage.ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"
            }
          >
            {installMessage.text}
          </p>
        ) : null}
        {inventory.error ? <p className="text-xs text-destructive">{inventory.error}</p> : null}
        {inventory.state === "loading" ? (
          <p className="py-4 text-center text-xs text-muted-foreground">Reading skills…</p>
        ) : !hasMatches ? (
          <p className="py-4 text-center text-xs text-muted-foreground">
            {inventory.entries.length === 0
              ? "No skills were found in any local agent root."
              : "No skills match that filter."}
          </p>
        ) : null}
      </SettingsSection>

      {grouped.map(({ root, entries }) =>
        entries.length === 0 ? null : (
          <SettingsSection key={root} title={ROOT_LABELS[root]}>
            <p className="px-1 text-xs text-muted-foreground">{ROOT_DESCRIPTIONS[root]}</p>
            <div className="space-y-1.5">
              {entries.map((entry) => (
                <SkillRow
                  key={`${entry.root}:${entry.path}`}
                  entry={entry}
                  sharing={inventory.sharing}
                  enabledByDefault={enabledByDefaultSet.has(entry.name)}
                  defaultEnableDisabled={
                    savingDefaultName !== null ||
                    (!enabledByDefaultSet.has(entry.name) &&
                      enabledByDefault.length >= ENABLED_BY_DEFAULT_SKILL_MAX_COUNT)
                  }
                  onToggleDefault={(name, enabled) => void toggleDefault(name, enabled)}
                  onShare={(sourcePath, targetRoot) => void inventory.share(sourcePath, targetRoot)}
                />
              ))}
            </div>
          </SettingsSection>
        ),
      )}
    </SettingsPageContainer>
  );
}
