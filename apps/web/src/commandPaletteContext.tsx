import { createContext, use, type ReactNode } from "react";
import type { EnvironmentId } from "@d4research/contracts";

export interface OpenDirectoryCommandPaletteOptions {
  readonly environmentId: EnvironmentId;
  readonly initialPath?: string;
  readonly onSelect: (path: string) => void | Promise<void>;
}

const OpenAddProjectCommandPaletteContext = createContext<(() => void) | null>(null);
const OpenCommandPaletteContext = createContext<(() => void) | null>(null);
const OpenDirectoryCommandPaletteContext = createContext<
  ((options: OpenDirectoryCommandPaletteOptions) => void) | null
>(null);

export function OpenAddProjectCommandPaletteProvider(props: {
  readonly children: ReactNode;
  readonly openAddProject: () => void;
  readonly openCommandPalette: () => void;
  readonly openDirectoryPicker: (options: OpenDirectoryCommandPaletteOptions) => void;
}) {
  return (
    <OpenDirectoryCommandPaletteContext value={props.openDirectoryPicker}>
      <OpenCommandPaletteContext value={props.openCommandPalette}>
        <OpenAddProjectCommandPaletteContext value={props.openAddProject}>
          {props.children}
        </OpenAddProjectCommandPaletteContext>
      </OpenCommandPaletteContext>
    </OpenDirectoryCommandPaletteContext>
  );
}

export function useOpenCommandPalette(): () => void {
  const openCommandPalette = use(OpenCommandPaletteContext);
  if (!openCommandPalette) {
    throw new Error("Command palette actions must be used inside CommandPalette");
  }
  return openCommandPalette;
}

export function useOpenAddProjectCommandPalette(): () => void {
  const openAddProject = use(OpenAddProjectCommandPaletteContext);
  if (!openAddProject) {
    throw new Error("Command palette actions must be used inside CommandPalette");
  }
  return openAddProject;
}

export function useOpenDirectoryCommandPalette(): (
  options: OpenDirectoryCommandPaletteOptions,
) => void {
  const openDirectoryPicker = use(OpenDirectoryCommandPaletteContext);
  if (!openDirectoryPicker) {
    throw new Error("Directory picker actions must be used inside CommandPalette");
  }
  return openDirectoryPicker;
}

/** Read at event time so the chat tree does not subscribe to transient dialog state. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
