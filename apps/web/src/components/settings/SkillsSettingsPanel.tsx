import { useMemo, useState } from "react";
import { Link2Icon, SearchIcon, Share2Icon } from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
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
];

const ROOT_LABELS: Readonly<Record<SkillsInventoryRoot, string>> = {
  project: "Project",
  "claude-user": "Claude (user)",
  "codex-user": "Codex (user)",
  "junie-user": "Junie (user)",
};

const ROOT_DESCRIPTIONS: Readonly<Record<SkillsInventoryRoot, string>> = {
  project: "Workspace skills under .agents/skills and .claude/skills.",
  "claude-user": "Skills under ~/.claude/skills, including category subdirectories.",
  "codex-user": "Skills under ~/.codex/skills, including the bundled .system set.",
  "junie-user": "Skills under ~/.junie/skills and commands under ~/.junie/commands.",
};

const AGENT_LABELS: Readonly<Record<SkillsInventoryAgent, string>> = {
  claude: "Claude",
  codex: "Codex",
  junie: "Junie",
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

function SkillRow({
  entry,
  sharing,
  onShare,
}: {
  readonly entry: SkillsInventoryEntry;
  readonly sharing: string | null;
  readonly onShare: (sourcePath: string, targetRoot: SkillsInventoryRoot) => void;
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
  const inventory = useSkillsInventory();
  const [query, setQuery] = useState("");

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

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("skills-inventory")}>
        <p className="px-1 text-xs text-muted-foreground">
          Every skill and command the local agents can see, merged across each agent&rsquo;s skills
          root. Share a skill to make it visible to another agent — d4research symlinks it into the
          target root, or copies it when symlinks are unavailable.
        </p>
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
