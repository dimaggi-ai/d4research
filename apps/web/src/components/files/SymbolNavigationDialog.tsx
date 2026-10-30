import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import type { ProjectCodeSearchMatch } from "@d4research/contracts";
import { Braces, FileCode2, Search } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { Dialog, DialogPopup } from "~/components/ui/dialog";

interface SymbolNavigationDialogProps {
  readonly open: boolean;
  readonly symbol: string;
  readonly mode: "definitions" | "usages";
  readonly matches: ReadonlyArray<ProjectCodeSearchMatch>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (match: ProjectCodeSearchMatch) => void;
}

function fileName(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  const separatorIndex = normalized.lastIndexOf("/");
  return separatorIndex === -1 ? normalized : normalized.slice(separatorIndex + 1);
}

function directoryName(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex === -1 ? "" : path.slice(0, separatorIndex);
}

function isWordBoundary(character: string | undefined): boolean {
  return character === undefined || !/[\p{L}\p{N}_$]/u.test(character);
}

/** Render the snippet with each whole-word occurrence of the symbol emphasized, JetBrains-style. */
function HighlightedSnippet({ snippet, symbol }: { snippet: string; symbol: string }): ReactNode {
  const text = snippet.trim();
  if (!symbol) return text;
  const lowerText = text.toLowerCase();
  const needle = symbol.toLowerCase();
  const nodes: ReactNode[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = lowerText.indexOf(needle, cursor);
    if (index === -1) {
      nodes.push(text.slice(cursor));
      break;
    }
    const wholeWord =
      isWordBoundary(text[index - 1]) && isWordBoundary(text[index + needle.length]);
    if (!wholeWord) {
      nodes.push(text.slice(cursor, index + needle.length));
      cursor = index + needle.length;
      continue;
    }
    if (index > cursor) nodes.push(text.slice(cursor, index));
    nodes.push(
      <span key={`match-${index}`} className="font-semibold text-foreground">
        {text.slice(index, index + needle.length)}
      </span>,
    );
    cursor = index + needle.length;
  }
  return nodes;
}

export function SymbolNavigationDialog(props: SymbolNavigationDialogProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filteredMatches = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return props.matches;
    return props.matches.filter((match) =>
      `${match.path} ${match.snippet}`.toLowerCase().includes(normalized),
    );
  }, [props.matches, query]);

  const modeLabel = props.mode === "usages" ? "usages" : "definitions";

  useEffect(() => {
    if (!props.open) return;
    setQuery("");
    setSelectedIndex(0);
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [props.open]);

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-row-index="${selectedIndex}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const select = (match: ProjectCodeSearchMatch) => {
    props.onOpenChange(false);
    props.onSelect(match);
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup
        aria-label={`${modeLabel} of ${props.symbol}`}
        className="max-w-3xl overflow-hidden rounded-lg p-0 duration-100 before:rounded-[7px]"
        showCloseButton={false}
        bottomStickOnMobile={false}
      >
        <div className="flex h-11 items-center gap-2 border-b border-border px-4">
          <span className="truncate text-sm font-semibold text-foreground">{props.symbol}</span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {props.matches.length} {props.matches.length === 1 ? modeLabel.slice(0, -1) : modeLabel}
          </span>
        </div>
        <div className="flex h-11 items-center gap-3 border-b border-border px-4">
          <Search className="size-4 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelectedIndex((current) => Math.min(filteredMatches.length - 1, current + 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelectedIndex((current) => Math.max(0, current - 1));
              } else if (event.key === "Enter") {
                const selected = filteredMatches[selectedIndex];
                if (selected) select(selected);
              }
            }}
            placeholder={`Filter ${modeLabel}`}
            className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div ref={listRef} className="max-h-[min(30rem,65vh)] min-h-48 overflow-y-auto py-1">
          {filteredMatches.length === 0 ? (
            <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
              No matching {modeLabel}
            </div>
          ) : (
            filteredMatches.map((match, index) => {
              const directory = directoryName(match.path);
              return (
                <button
                  key={`${match.path}:${match.lineNumber}:${match.column}`}
                  type="button"
                  data-row-index={index}
                  className={cn(
                    "flex w-full min-w-0 items-center gap-3 px-3 py-1.5 text-left",
                    index === selectedIndex ? "bg-accent" : "hover:bg-accent/60",
                  )}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => select(match)}
                >
                  {match.isDefinition ? (
                    <Braces className="size-4 shrink-0 text-violet-500" />
                  ) : (
                    <FileCode2 className="size-4 shrink-0 text-sky-500" />
                  )}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="flex w-52 shrink-0 items-baseline gap-1.5">
                          <span className="truncate text-sm text-foreground">
                            {fileName(match.path)}
                          </span>
                          {directory ? (
                            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                              {directory}
                            </span>
                          ) : null}
                          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
                            {match.lineNumber}
                          </span>
                        </span>
                      }
                    />
                    <TooltipPopup>{`${match.path}:${match.lineNumber}`}</TooltipPopup>
                  </Tooltip>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
                    <HighlightedSnippet snippet={match.snippet} symbol={props.symbol} />
                  </span>
                </button>
              );
            })
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
