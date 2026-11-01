import { CheckIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Popover, PopoverPopup } from "../ui/popover";
import {
  RAIL_GROUP_COLORS,
  railGroupName,
  railGroupShortLabel,
  type RailGroup,
  type RailGroupColor,
} from "./projectRailGroups.logic";
import { railGroupSwatchHex } from "./projectRailMenus";

type PopoverAnchor = Element | (() => Element | null) | null;

function RailGroupSwatches({
  value,
  onChange,
}: {
  value: RailGroupColor;
  onChange: (color: RailGroupColor) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Group color" className="flex flex-wrap gap-1.5">
      {RAIL_GROUP_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-checked={value === color}
          aria-label={color}
          className={cn(
            "grid size-5 cursor-pointer place-items-center rounded-full text-white outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            value === color && "ring-2 ring-foreground/70 ring-inset",
          )}
          style={{ backgroundColor: railGroupSwatchHex(color) }}
          onClick={() => onChange(color)}
        >
          {value === color ? <CheckIcon aria-hidden className="size-3" /> : null}
        </button>
      ))}
    </div>
  );
}

function RailPopover({
  open,
  anchor,
  title,
  onClose,
  children,
}: {
  open: boolean;
  anchor: PopoverAnchor;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <PopoverPopup
        anchor={anchor}
        side="right"
        align="start"
        sideOffset={8}
        padding="compact"
        className="w-72"
        aria-label={title}
      >
        <div className="flex flex-col gap-3 py-1">{children}</div>
      </PopoverPopup>
    </Popover>
  );
}

export function RailGroupEditorPopover({
  group,
  anchor,
  onClose,
  onRename,
  onRecolor,
  onUngroup,
}: {
  group: RailGroup | null;
  anchor: PopoverAnchor;
  onClose: () => void;
  onRename: (name: string) => void;
  onRecolor: (color: RailGroupColor) => void;
  onUngroup: () => void;
}) {
  return (
    <RailPopover open={group !== null} anchor={anchor} title="Edit group" onClose={onClose}>
      {group ? (
        <>
          <Input
            size="sm"
            autoFocus
            aria-label="Group name"
            placeholder="Name this group"
            value={group.name}
            onChange={(event) => onRename(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onClose();
              }
            }}
          />
          <RailGroupSwatches value={group.color} onChange={onRecolor} />
          <p className="text-xs text-muted-foreground">
            Short rail label:{" "}
            <span className="font-semibold text-foreground">{railGroupShortLabel(group.name)}</span>
          </p>
          <div className="flex items-center justify-between gap-2">
            <Button size="sm" variant="ghost" onClick={onUngroup}>
              Ungroup
            </Button>
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          </div>
        </>
      ) : null}
    </RailPopover>
  );
}

export function RailNewGroupPopover({
  open,
  anchor,
  projects,
  groupOf,
  initialColor,
  onClose,
  onCreate,
}: {
  open: boolean;
  anchor: PopoverAnchor;
  projects: ReadonlyArray<SidebarProjectSnapshot>;
  groupOf: (projectKey: string) => RailGroup | null;
  initialColor: RailGroupColor;
  onClose: () => void;
  onCreate: (input: {
    name: string;
    color: RailGroupColor;
    projectKeys: ReadonlyArray<string>;
  }) => void;
}) {
  return (
    <RailPopover open={open} anchor={anchor} title="New group" onClose={onClose}>
      {open ? (
        <RailNewGroupForm
          projects={projects}
          groupOf={groupOf}
          initialColor={initialColor}
          onCreate={onCreate}
        />
      ) : null}
    </RailPopover>
  );
}

function RailNewGroupForm({
  projects,
  groupOf,
  initialColor,
  onCreate,
}: {
  projects: ReadonlyArray<SidebarProjectSnapshot>;
  groupOf: (projectKey: string) => RailGroup | null;
  initialColor: RailGroupColor;
  onCreate: (input: {
    name: string;
    color: RailGroupColor;
    projectKeys: ReadonlyArray<string>;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(initialColor);
  const [picked, setPicked] = useState<ReadonlyArray<string>>([]);
  const create = () => {
    if (picked.length > 0) onCreate({ name, color, projectKeys: picked });
  };
  return (
    <>
      <p className="text-sm font-semibold">New group</p>
      <Input
        size="sm"
        autoFocus
        aria-label="Group name"
        placeholder="Name this group"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            create();
          }
        }}
      />
      <RailGroupSwatches value={color} onChange={setColor} />
      <div
        role="group"
        aria-label="Projects in this group"
        className="flex max-h-56 flex-col overflow-y-auto rounded-lg border p-1"
      >
        {projects.map((project) => {
          const current = groupOf(project.projectKey);
          const checked = picked.includes(project.projectKey);
          return (
            <label
              key={project.projectKey}
              className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-accent"
            >
              <Checkbox
                checked={checked}
                onCheckedChange={(next) =>
                  setPicked((keys) =>
                    next
                      ? [...keys, project.projectKey]
                      : keys.filter((key) => key !== project.projectKey),
                  )
                }
              />
              <span className="grid size-4 shrink-0 place-items-center overflow-hidden">
                <ProjectFavicon project={project} className="size-full" />
              </span>
              <span className="min-w-0 flex-1 truncate">{project.displayName}</span>
              {current ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  in {railGroupName(current)}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
      <div className="flex justify-end">
        <Button size="sm" disabled={picked.length === 0} onClick={create}>
          Create group
        </Button>
      </div>
    </>
  );
}
