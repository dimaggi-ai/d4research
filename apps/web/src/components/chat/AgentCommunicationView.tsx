import { useMemo, useState } from "react";
import { NetworkIcon, MessagesSquareIcon } from "lucide-react";
import {
  selectCommunicationMessages,
  recentCommunicationParticipants,
  communicationParticipantActivity,
  communicationStatusTone,
  communicationStatusLabel,
  type ThreadCommunication,
  type CommunicationSelection,
  type CommunicationParticipant,
} from "@d4research/client-runtime/state/thread-communication";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import {
  AgentCommunicationMessage,
  type CommunicationReadingMode,
} from "./AgentCommunicationMessage";

import { communicationStatusClasses as statusClasses } from "./agentCommunicationStyles";
import { AgentCommunicationMap } from "./AgentCommunicationMap";
import { AgentCommunicationAvatar } from "./AgentCommunicationAvatar";

export function AgentCommunicationView(props: {
  readonly model: ThreadCommunication;
  readonly selection: CommunicationSelection;
  readonly onSelect: (selection: CommunicationSelection) => void;
  readonly loading?: boolean;
  readonly onOpenThread?: (participant: CommunicationParticipant) => void;
  readonly historyActions?: React.ReactNode;
}) {
  const [mapOpen, setMapOpen] = useState(false);
  const [readingMode, setReadingMode] = useState<CommunicationReadingMode>("preview");
  const [readingRevision, setReadingRevision] = useState(0);
  const changeReadingMode = (mode: CommunicationReadingMode) => {
    setReadingMode(mode);
    setReadingRevision((revision) => revision + 1);
  };
  const [visibleCount, setVisibleCount] = useState(30);
  const { model, selection } = props;
  const byId = new Map(model.participants.map((p) => [p.id, p]));
  const [query, setQuery] = useState("");
  const [taskLimit, setTaskLimit] = useState(50);
  const activity = useMemo(() => communicationParticipantActivity(model), [model]);
  const tasks = useMemo(
    () => recentCommunicationParticipants(model).filter((p) => p.id !== model.rootId),
    [model],
  );
  const filteredTasks = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term
      ? tasks.filter((p) =>
          `${p.label} ${p.environmentLabel} ${p.model ?? ""}`.toLocaleLowerCase().includes(term),
        )
      : tasks;
  }, [tasks, query]);
  const shownTasks = filteredTasks.slice(0, taskLimit);
  const updateQuery = (value: string) => {
    setQuery(value);
    setTaskLimit(50);
  };

  const messages = selectCommunicationMessages(model, selection);
  const visibleMessages = messages.slice(-visibleCount).toReversed();
  const counts = new Map<string, number>();
  for (const message of model.messages)
    for (const id of new Set([message.from, message.to])) counts.set(id, (counts.get(id) ?? 0) + 1);
  const heading =
    selection.kind === "all"
      ? "All conversations"
      : selection.kind === "participant"
        ? (byId.get(selection.id)?.label ?? "Task conversation")
        : `${byId.get(selection.from)?.label ?? "Agent"} ↔ ${byId.get(selection.to)?.label ?? "Agent"}`;
  const choose = (next: CommunicationSelection) => {
    setVisibleCount(30);
    props.onSelect(next);
  };
  return (
    <div
      className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[16rem_minmax(0,1fr)]"
      data-agent-communication-view
    >
      <nav
        aria-label="Task conversations"
        className="hidden min-h-0 flex-col border-r bg-muted/10 md:flex"
      >
        <div className="shrink-0 space-y-2 p-3">
          <p className="px-2 text-xs font-medium text-muted-foreground">Conversations</p>
          <Input
            size="compact"
            type="search"
            aria-label="Search task conversations"
            placeholder="Search tasks…"
            value={query}
            onChange={(event) => updateQuery(event.target.value)}
          />
          <p className="px-2 text-2xs text-muted-foreground">
            {plural(tasks.length, "task")} · Latest activity first
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          <TaskButton
            agentId={model.rootId}
            coordinator
            label="All conversations"
            count={model.messages.length}
            selected={selection.kind === "all"}
            onClick={() => choose({ kind: "all" })}
          />
          {shownTasks.map((p) => (
            <TaskButton
              key={p.id}
              taskId={p.id}
              agentId={p.id}
              label={p.label}
              detail={
                <>
                  <span className={statusClasses[communicationStatusTone(p.status)]}>
                    {communicationStatusLabel(p.status)}
                  </span>{" "}
                  · {p.environmentLabel}
                </>
              }
              count={counts.get(p.id) ?? 0}
              at={activity.get(p.id) ?? 0}
              selected={selection.kind === "participant" && selection.id === p.id}
              onClick={() => choose({ kind: "participant", id: p.id })}
            />
          ))}
          {!filteredTasks.length ? (
            <p className="p-2 text-xs text-muted-foreground">No matching tasks.</p>
          ) : null}
          {filteredTasks.length > taskLimit ? (
            <Button size="xs" variant="ghost" onClick={() => setTaskLimit((count) => count + 50)}>
              Show {Math.min(50, filteredTasks.length - taskLimit)} more tasks
            </Button>
          ) : null}
        </div>
      </nav>
      <div className="flex min-h-0 min-w-0 flex-col">
        <div className="shrink-0 space-y-2 border-b px-4 py-2 md:hidden">
          {tasks.length > 10 ? (
            <Input
              size="compact"
              type="search"
              aria-label="Search task conversations on mobile"
              placeholder="Search tasks…"
              value={query}
              onChange={(event) => updateQuery(event.target.value)}
            />
          ) : null}
          <label className="flex items-center gap-2 text-xs">
            Task
            <select
              aria-label="Task conversation"
              className="min-w-0 flex-1 rounded-md border bg-background p-2 text-sm"
              value={
                selection.kind === "participant"
                  ? selection.id
                  : selection.kind === "connection"
                    ? "connection"
                    : "all"
              }
              onChange={(event) =>
                choose(
                  event.target.value === "all"
                    ? { kind: "all" }
                    : { kind: "participant", id: event.target.value },
                )
              }
            >
              <option value="all">All conversations</option>
              {selection.kind === "connection" ? (
                <option value="connection" disabled>
                  Selected connection
                </option>
              ) : null}
              {selection.kind === "participant" &&
              !shownTasks.some((p) => p.id === selection.id) ? (
                <option value={selection.id}>
                  {byId.get(selection.id)?.label ?? "Selected task"}
                </option>
              ) : null}
              {shownTasks.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {mapOpen ? (
          <section aria-label="Connection map" className="flex min-h-0 shrink flex-col border-b">
            <AgentCommunicationMap model={model} selection={selection} onSelect={choose} />
          </section>
        ) : null}
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
          <span className="flex shrink-0 -space-x-2">
            {(selection.kind === "all"
              ? [model.rootId]
              : selection.kind === "participant"
                ? [selection.id]
                : [selection.from, selection.to]
            ).map((id) => (
              <AgentCommunicationAvatar
                key={id}
                id={id}
                label={byId.get(id)?.label ?? "Agent"}
                coordinator={id === model.rootId}
                size="md"
              />
            ))}
          </span>
          <div className="min-w-0 flex-1 basis-40">
            <h3 className="truncate text-sm font-medium">{heading}</h3>
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {selection.kind === "all"
                ? (byId.get(model.rootId)?.label ?? "This thread")
                : "Assignments, replies, and messages"}
            </p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {selection.kind !== "all" ? (
              <Button size="xs" variant="ghost" onClick={() => choose({ kind: "all" })}>
                Overview
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost-muted"
              aria-expanded={mapOpen}
              onClick={() => setMapOpen(!mapOpen)}
            >
              <NetworkIcon aria-hidden />
              {mapOpen ? "Hide map" : "Show map"}
            </Button>
          </div>
        </div>
        <div
          className="flex shrink-0 flex-wrap items-center gap-1 border-b px-4 py-2"
          role="group"
          aria-label="Message display"
        >
          {(
            [
              ["compact", "Collapse all"],
              ["preview", "Short previews"],
              ["full", "Expand all"],
            ] as const
          ).map(([mode, label]) => (
            <Button
              key={mode}
              size="micro"
              variant={readingMode === mode ? "secondary" : "ghost-muted"}
              aria-pressed={readingMode === mode}
              onClick={() => changeReadingMode(mode)}
            >
              {label}
            </Button>
          ))}
          <span className="ml-auto hidden text-2xs text-muted-foreground sm:block">
            Newest first
          </span>
        </div>
        <section
          aria-label="Messages between agents"
          className="min-h-24 flex-1 overflow-y-auto overscroll-contain px-4 pb-4"
          key={JSON.stringify(selection)}
        >
          {visibleMessages.map((message) => {
            const from = byId.get(message.from);
            const to = byId.get(message.to);
            return (
              <AgentCommunicationMessage
                key={`${message.id}:${readingRevision}`}
                message={message}
                from={{
                  id: message.from,
                  label: from?.label ?? "Agent",
                  coordinator: message.from === model.rootId,
                }}
                to={{
                  id: message.to,
                  label: to?.label ?? "Agent",
                  coordinator: message.to === model.rootId,
                }}
                environment={
                  from?.environmentLabel === to?.environmentLabel
                    ? (from?.environmentLabel ?? "")
                    : `${from?.environmentLabel ?? "Unknown environment"} → ${to?.environmentLabel ?? "Unknown environment"}`
                }
                mode={readingMode}
              />
            );
          })}
          {messages.length > visibleCount ? (
            <div className="py-3">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setVisibleCount((count) => count + 30)}
              >
                Show {Math.min(30, messages.length - visibleCount)} older messages
              </Button>
            </div>
          ) : null}
          {messages.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
              <MessagesSquareIcon aria-hidden className="size-6" />
              <p>
                {props.loading
                  ? "Loading recorded messages…"
                  : "No recorded communication in the loaded history."}
              </p>
              <p className="max-w-sm text-xs">
                Messages appear here when agents send them. Existing task prompts and results are
                included; notes written only to files are not chat messages.
              </p>
            </div>
          ) : null}
        </section>
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
          <span>
            {plural(messages.length, "recorded exchange")}
            {props.loading ? " · Loading task…" : ""}
          </span>
          <div className="flex flex-wrap gap-2">
            {props.historyActions}
            {selection.kind === "participant" &&
            byId.get(selection.id)?.threadId &&
            props.onOpenThread ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => props.onOpenThread?.(byId.get(selection.id)!)}
              >
                Open thread
              </Button>
            ) : null}
          </div>
        </footer>
      </div>
    </div>
  );
}

const formatActivityTime = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function TaskButton(props: {
  agentId: string;
  coordinator?: boolean;
  label: string;
  detail?: React.ReactNode;
  count: number;
  taskId?: string;
  at?: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      data-communication-task={props.taskId}
      onClick={props.onClick}
      className={cn(
        "mb-0.5 flex w-full min-w-0 gap-2.5 rounded-md px-2.5 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.selected ? "bg-accent text-accent-foreground" : "hover:bg-muted/50",
      )}
    >
      <AgentCommunicationAvatar
        id={props.agentId}
        label={props.label}
        coordinator={props.coordinator ?? false}
      />
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 break-words text-xs font-medium [overflow-wrap:anywhere]">
          {props.label}
        </span>
        {props.detail ? (
          <span className="mt-0.5 block truncate text-2xs text-muted-foreground">
            {props.detail}
          </span>
        ) : null}
        <span className="mt-1 flex flex-wrap gap-x-2 text-2xs text-muted-foreground tabular-nums">
          <span>{plural(props.count, "exchange")}</span>
          {props.at ? (
            <time dateTime={new Date(props.at).toISOString()}>
              {formatActivityTime.format(props.at)}
            </time>
          ) : null}
        </span>
      </span>
    </button>
  );
}
