import {
  ENABLED_BY_DEFAULT_SKILL_MAX_COUNT,
  type EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { mergeEnabledSkillNames } from "@t3tools/shared/enabledSkillsContext";
import { CheckIcon, SearchIcon, SparklesIcon } from "lucide-react";
import { memo, type ComponentProps, useEffect, useMemo, useState } from "react";

import {
  type SkillsInventoryEntry,
  type SkillsInventoryRoot,
} from "../../hooks/useSkillsInventory";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

const ROOT_PRIORITY: Record<SkillsInventoryRoot, number> = {
  project: 0,
  "codex-user": 1,
  "claude-user": 2,
  "junie-user": 3,
  "agy-user": 4,
};
const EMPTY_SKILL_NAMES: ReadonlyArray<string> = [];

export interface SessionSkillOption {
  readonly name: string;
  readonly description: string | null;
  readonly missing: boolean;
}

/** Match server shadowing: one project definition, otherwise one shared user definition. */
export function buildSessionSkillOptions(
  entries: ReadonlyArray<SkillsInventoryEntry>,
  configuredNames: ReadonlyArray<string>,
): Array<SessionSkillOption> {
  const options = new Map<string, SessionSkillOption>();
  for (const entry of [...entries]
    .filter((candidate) => candidate.kind === "skill")
    .sort((left, right) => ROOT_PRIORITY[left.root] - ROOT_PRIORITY[right.root])) {
    if (options.has(entry.name)) continue;
    options.set(entry.name, {
      name: entry.name,
      description: entry.description?.trim() || null,
      missing: false,
    });
  }
  for (const name of configuredNames) {
    if (!options.has(name)) options.set(name, { name, description: null, missing: true });
  }
  return [...options.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function ComposerSessionSkillsTriggerButton({
  effectiveCount,
  hasSessionSkills,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "children"> & {
  readonly effectiveCount: number;
  readonly hasSessionSkills: boolean;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className={cn(
        "size-7 shrink-0 justify-center p-0",
        hasSessionSkills && "bg-info/10 text-info-foreground hover:bg-info/15",
        className,
      )}
      aria-label={`${effectiveCount} ${effectiveCount === 1 ? "skill" : "skills"} configured for this chat`}
      title="Skills for this chat"
      data-chat-session-skills-trigger="true"
      {...props}
    >
      <SparklesIcon className="size-3.5" aria-hidden="true" />
    </Button>
  );
}

export const ComposerSessionSkillsControl = memo(function ComposerSessionSkillsControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly globalNames: ReadonlyArray<string>;
  readonly enabledByThread: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly inventoryEntries: ReadonlyArray<SkillsInventoryEntry>;
  readonly inventoryState: "loading" | "ready" | "error";
  readonly disabled?: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const [query, setQuery] = useState("");
  const [savingName, setSavingName] = useState<string | null>(null);
  const globalSet = useMemo(() => new Set(props.globalNames), [props.globalNames]);
  const configuredSessionNames = props.enabledByThread[props.threadId] ?? EMPTY_SKILL_NAMES;
  const sessionNames = useMemo(
    () => configuredSessionNames.filter((name) => !globalSet.has(name)),
    [configuredSessionNames, globalSet],
  );
  const sessionSet = useMemo(() => new Set(sessionNames), [sessionNames]);
  const effectiveNames = useMemo(
    () => mergeEnabledSkillNames(props.globalNames, sessionNames),
    [props.globalNames, sessionNames],
  );
  useEffect(() => {
    if (props.disabled && props.open) props.onOpenChange(false);
  }, [props.disabled, props.onOpenChange, props.open]);
  const options = useMemo(
    () => buildSessionSkillOptions(props.inventoryEntries, [...props.globalNames, ...sessionNames]),
    [props.globalNames, props.inventoryEntries, sessionNames],
  );
  const visibleOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return options;
    return options.filter(
      (option) =>
        option.name.toLocaleLowerCase().includes(normalizedQuery) ||
        option.description?.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [options, query]);

  const toggleSessionSkill = async (name: string) => {
    if (props.disabled || globalSet.has(name) || savingName !== null) return;
    const enabled = !sessionSet.has(name);
    setSavingName(name);
    try {
      await updateSettings({
        skills: {
          setEnabledForThreadSkill: {
            threadId: ThreadId.make(props.threadId),
            name,
            enabled,
          },
        },
      });
    } finally {
      setSavingName(null);
    }
  };

  const activeSessionCount = sessionNames.filter((name) => !globalSet.has(name)).length;
  return (
    <Popover
      open={props.open}
      onOpenChange={(open) => {
        if (!props.disabled) props.onOpenChange(open);
      }}
    >
      <PopoverTrigger
        render={
          <ComposerSessionSkillsTriggerButton
            disabled={props.disabled}
            effectiveCount={effectiveNames.length}
            hasSessionSkills={activeSessionCount > 0}
          />
        }
      />
      <PopoverPopup
        side="top"
        align="start"
        sideOffset={8}
        className="w-80 max-w-[calc(100vw-2rem)]"
        viewportClassName="p-0!"
        data-chat-session-skills-popup="true"
      >
        <div className="border-b border-border/60 px-3 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <PopoverTitle className="text-sm">Skills for this chat</PopoverTitle>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Global skills stay on. Add skills only this chat needs.
              </p>
            </div>
            <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {effectiveNames.length}/{ENABLED_BY_DEFAULT_SKILL_MAX_COUNT}
            </span>
          </div>
          <div className="relative mt-2.5">
            <SearchIcon
              className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              nativeInput
              size="sm"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              disabled={props.disabled}
              placeholder="Find a skill"
              aria-label="Find a skill"
              className="ps-7.5"
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto p-1.5">
          {props.inventoryState === "loading" && options.length === 0 ? (
            <p className="px-2 py-5 text-center text-xs text-muted-foreground">Loading skills…</p>
          ) : props.inventoryState === "error" && options.length === 0 ? (
            <p className="px-2 py-5 text-center text-xs text-destructive">
              Skills inventory is unavailable.
            </p>
          ) : visibleOptions.length === 0 ? (
            <p className="px-2 py-5 text-center text-xs text-muted-foreground">
              No matching skills.
            </p>
          ) : (
            visibleOptions.map((option) => {
              const globallyEnabled = globalSet.has(option.name);
              const sessionEnabled = sessionSet.has(option.name) && !globallyEnabled;
              const selected = globallyEnabled || sessionEnabled;
              const limitReached =
                !selected && effectiveNames.length >= ENABLED_BY_DEFAULT_SKILL_MAX_COUNT;
              const disabled = globallyEnabled || limitReached || savingName !== null;
              const itemDisabled = props.disabled || disabled;
              return (
                <button
                  key={option.name}
                  type="button"
                  role="checkbox"
                  aria-checked={selected}
                  disabled={itemDisabled}
                  data-chat-session-skill={option.name}
                  data-chat-session-skill-scope={
                    globallyEnabled ? "global" : sessionEnabled ? "session" : "off"
                  }
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md px-2 py-2 text-start outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50",
                    itemDisabled && !globallyEnabled && "opacity-50",
                  )}
                  onClick={() => void toggleSessionSkill(option.name)}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border",
                      selected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-input bg-background",
                    )}
                    aria-hidden="true"
                  >
                    {selected ? <CheckIcon className="size-3" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-xs font-medium">{option.name}</span>
                      {globallyEnabled ? (
                        <Badge size="sm" variant="secondary">
                          Global
                        </Badge>
                      ) : sessionEnabled ? (
                        <Badge size="sm" variant="info">
                          This chat
                        </Badge>
                      ) : null}
                      {option.missing ? (
                        <Badge size="sm" variant="warning">
                          Missing
                        </Badge>
                      ) : null}
                    </span>
                    {option.description ? (
                      <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-muted-foreground">
                        {option.description}
                      </span>
                    ) : option.missing ? (
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">
                        Not found in this project or user inventory. Remove it here.
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
