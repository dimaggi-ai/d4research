import { useState } from "react";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  BotIcon,
  GitBranchIcon,
  MessagesSquareIcon,
  MonitorIcon,
} from "lucide-react";
import {
  communicationStatusLabel,
  communicationStatusTone,
  type CommunicationMessage,
  type CommunicationParticipant,
  type CommunicationSelection,
  type ThreadCommunication,
} from "@d4research/client-runtime/state/thread-communication";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { communicationStatusClasses } from "./agentCommunicationStyles";
import { AgentCommunicationAvatar } from "./AgentCommunicationAvatar";

interface Connection {
  readonly from: string;
  readonly to: string;
  readonly outgoing: CommunicationMessage[];
  readonly incoming: CommunicationMessage[];
  lastAt: number;
}

const connectionKey = (from: string, to: string) => [from, to].sort().join("\0");

/** Layout depends on recorded parentage, never the current selection. */
export function AgentCommunicationMap(props: {
  readonly model: ThreadCommunication;
  readonly selection: CommunicationSelection;
  readonly onSelect: (selection: CommunicationSelection) => void;
}) {
  const { model, selection, onSelect } = props;
  const byId = new Map(model.participants.map((participant) => [participant.id, participant]));
  const [expanded, setExpanded] = useState(false);
  const [focused, setFocused] = useState<CommunicationSelection | null>(null);
  const [linkLimit, setLinkLimit] = useState(6);
  const focusedIds = new Set<string>();
  if (focused !== null && focused.kind !== "all") {
    const seeds = focused.kind === "participant" ? [focused.id] : [focused.from, focused.to];
    for (const seed of seeds) {
      let id: string | null = seed;
      while (id !== null && !focusedIds.has(id)) {
        focusedIds.add(id);
        id = byId.get(id)?.parentId ?? null;
      }
    }
    focusedIds.add(model.rootId);
  }
  const participants = model.participants.filter(
    (participant) => !focusedIds.size || focusedIds.has(participant.id),
  );
  const branchLimit = expanded || focused !== null ? Infinity : 6;

  const children = new Map<string, CommunicationParticipant[]>();
  const peers: CommunicationParticipant[] = [];
  const root = byId.get(model.rootId);
  // Resolve cycles and missing parents as separate threads, without inventing a delegation.
  const parentOf = (participant: CommunicationParticipant) => {
    const visited = new Set([participant.id]);
    let parentId = participant.parentId;
    while (parentId !== null) {
      if (visited.has(parentId) || !byId.has(parentId)) return null;
      visited.add(parentId);
      parentId = byId.get(parentId)!.parentId;
    }
    return participant.parentId;
  };
  for (const participant of participants) {
    if (participant.id === model.rootId) continue;
    const parentId = parentOf(participant);
    if (parentId === null) peers.push(participant);
    else {
      const group = children.get(parentId) ?? [];
      group.push(participant);
      children.set(parentId, group);
    }
  }
  const connections = new Map<string, Connection>();
  for (const message of model.messages) {
    if (message.from === message.to) continue;
    const key = connectionKey(message.from, message.to);
    let connection = connections.get(key);
    if (!connection) {
      const recipient = byId.get(message.to);
      const sender = byId.get(message.from);
      const parentIsRecipient =
        sender !== undefined && recipient !== undefined && sender.parentId === recipient.id;
      connection = {
        from: parentIsRecipient ? message.to : message.from,
        to: parentIsRecipient ? message.from : message.to,
        outgoing: [],
        incoming: [],
        lastAt: 0,
      };
      connections.set(key, connection);
    }
    (message.from === connection.from ? connection.outgoing : connection.incoming).push(message);
    connection.lastAt = Math.max(connection.lastAt, Date.parse(message.at) || 0);
  }
  const selected = (id: string) =>
    selection.kind === "all"
      ? id === model.rootId
      : selection.kind === "participant"
        ? selection.id === id
        : selection.from === id || selection.to === id;
  const selectedConnection = (from: string, to: string) =>
    selection.kind === "connection" &&
    connectionKey(selection.from, selection.to) === connectionKey(from, to);
  const node = (participant: CommunicationParticipant, coordinator = false) => {
    const tone = communicationStatusTone(participant.status);
    const role = coordinator
      ? "Coordinator"
      : participant.parentId !== null
        ? "Subagent"
        : "Other thread";
    const status = communicationStatusLabel(participant.status);
    const Icon = coordinator
      ? GitBranchIcon
      : participant.parentId !== null
        ? BotIcon
        : MessagesSquareIcon;
    return (
      <button
        type="button"
        data-communication-agent={participant.id}
        aria-label={`Read exchanges with ${participant.label}`}
        aria-pressed={selected(participant.id)}
        onClick={() =>
          onSelect(coordinator ? { kind: "all" } : { kind: "participant", id: participant.id })
        }
        className={cn(
          "relative block w-full min-w-0 rounded-xl border bg-background p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          selected(participant.id)
            ? "border-primary bg-primary/5 ring-1 ring-inset ring-primary/20"
            : "border-border hover:bg-muted/50",
        )}
      >
        <span className="mb-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-2xs">
          <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
            <Icon aria-hidden className="size-3.5" />
            {role}
          </span>
          <span className={cn("flex items-center gap-1.5", communicationStatusClasses[tone])}>
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
            {status}
          </span>
        </span>
        <span className="flex items-start gap-2">
          {coordinator ? null : (
            <AgentCommunicationAvatar id={participant.id} label={participant.label} size="xs" />
          )}
          <span className="min-w-0 break-words text-sm font-medium leading-snug [overflow-wrap:anywhere]">
            {participant.label}
          </span>
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-1.5 break-words [overflow-wrap:anywhere]">
            <MonitorIcon aria-hidden className="size-3 shrink-0" />
            {participant.environmentLabel}
          </span>
          {participant.model ? (
            <span className="break-words [overflow-wrap:anywhere]">· {participant.model}</span>
          ) : null}
        </span>
      </button>
    );
  };
  const flow = (from: CommunicationParticipant, to: CommunicationParticipant, hierarchy = true) => {
    const connection = connections.get(connectionKey(from.id, to.id));
    const outgoing = connection
      ? connection.from === from.id
        ? connection.outgoing
        : connection.incoming
      : [];
    const incoming = connection
      ? connection.from === from.id
        ? connection.incoming
        : connection.outgoing
      : [];
    return (
      <button
        type="button"
        aria-label={`Read connection between ${from.label} and ${to.label}`}
        aria-pressed={selectedConnection(from.id, to.id)}
        disabled={!connection}
        onClick={() => onSelect({ kind: "connection", from: from.id, to: to.id })}
        aria-description={`${from.label} → ${to.label}: ${messageCount(outgoing)}. ${to.label} → ${from.label}: ${messageCount(incoming)}.`}
        className={cn(
          "mb-1.5 flex max-w-full flex-wrap items-center text-left gap-x-3 gap-y-1 rounded-md px-2 py-1 text-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default",
          selectedConnection(from.id, to.id)
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground enabled:hover:bg-muted enabled:hover:text-foreground",
        )}
      >
        <span className="flex min-w-0 items-center gap-1 break-words [overflow-wrap:anywhere]">
          {hierarchy ? (
            <ArrowDownIcon aria-hidden className="size-3 shrink-0" />
          ) : (
            <ArrowRightIcon aria-hidden className="size-3 shrink-0" />
          )}
          {!hierarchy ? `${from.label} → ${to.label} · ` : ""}
          {messageCount(outgoing)}
        </span>
        <span className="flex min-w-0 items-center gap-1 break-words [overflow-wrap:anywhere]">
          {hierarchy ? (
            <ArrowUpIcon aria-hidden className="size-3 shrink-0" />
          ) : (
            <ArrowLeftIcon aria-hidden className="size-3 shrink-0" />
          )}
          {!hierarchy ? `${to.label} → ${from.label} · ` : ""}
          {incoming.length ? messageCount(incoming) : "No reply recorded"}
        </span>
      </button>
    );
  };
  const branches = (parent: CommunicationParticipant, coordinator = false): React.ReactNode => {
    const allAgents = children.get(parent.id) ?? [];
    const agents = allAgents.slice(0, branchLimit);
    if (!agents.length) return null;
    return (
      <ol
        aria-label={`Tasks delegated by ${parent.label}`}
        className={cn(
          coordinator
            ? "grid grid-cols-1 gap-3 border-t border-border pt-3"
            : "space-y-3 border-l border-border pl-5",
          coordinator &&
            (agents.length === 1
              ? "md:grid-cols-1"
              : agents.length === 2
                ? "md:grid-cols-2"
                : "md:grid-cols-3"),
        )}
      >
        {agents.map((participant, index) => (
          <li
            key={participant.id}
            className={cn(
              "relative min-w-0",
              coordinator
                ? index < 3 &&
                    "before:absolute before:-top-3 before:left-1/2 before:h-3 before:w-px before:bg-border"
                : "before:absolute before:top-9 before:-left-5 before:h-px before:w-5 before:bg-border",
            )}
          >
            {flow(parent, participant)}
            {node(participant)}
            {children.has(participant.id) ? (
              <div className="mt-3 ml-3">{branches(participant)}</div>
            ) : null}
          </li>
        ))}
        {agents.length < allAgents.length ? (
          <li className={coordinator ? "md:col-span-full" : undefined}>
            <Button size="xs" variant="ghost" onClick={() => setExpanded(true)}>
              Show {allAgents.length - agents.length} more tasks on this branch
            </Button>
          </li>
        ) : null}
      </ol>
    );
  };
  const directConnections = [...connections.values()]
    .filter(({ from, to }) => !focusedIds.size || (focusedIds.has(from) && focusedIds.has(to)))
    .filter(({ from, to }) => byId.get(from)?.parentId !== to && byId.get(to)?.parentId !== from);
  directConnections.sort((a, b) => b.lastAt - a.lastAt);
  const environments = new Set(model.participants.map((participant) => participant.environmentId));
  return (
    <div
      className={cn(
        "max-h-[min(42dvh,25rem,max(5rem,calc(100dvh-29rem)))] max-md:max-h-[min(28dvh,25rem,max(5rem,calc(100dvh-29rem)))] min-h-0 overflow-auto overscroll-contain scrollbar-gutter-both px-4 pb-4",
        model.participants.length > 11 &&
          "max-md:max-h-[min(26dvh,25rem,max(3rem,calc(100dvh-31rem)))]",
      )}
      aria-label="Agents in the map"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-2xs text-muted-foreground">
        <p>
          {model.participants.length} agents total · {environments.size}{" "}
          {environments.size === 1 ? "machine" : "machines"} · {model.messages.length} exchanges
        </p>
        <p className="flex flex-wrap gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1">
            <ArrowDownIcon aria-hidden className="size-3" />
            Task / message
          </span>
          <span className="inline-flex items-center gap-1">
            <ArrowUpIcon aria-hidden className="size-3" />
            Reply
          </span>
        </p>
      </div>
      <div className="mb-3 flex min-h-6 flex-wrap items-center justify-between gap-2">
        <p className="text-2xs text-muted-foreground">
          {focused !== null
            ? "Focused conversation"
            : expanded
              ? "All task branches"
              : "Overview · Task hierarchy"}
        </p>
        <div className="flex flex-wrap items-center gap-1">
          {model.participants.length > 7 && focused === null ? (
            <Button size="xs" variant="ghost" onClick={() => setExpanded(!expanded)}>
              {expanded ? "Compact overview" : `Show all ${model.participants.length} agents`}
            </Button>
          ) : null}
          {focused !== null ? (
            <Button size="xs" variant="ghost" onClick={() => setFocused(null)}>
              Back to overview
            </Button>
          ) : selection.kind !== "all" ? (
            <Button size="xs" variant="ghost" onClick={() => setFocused(selection)}>
              Focus selection
            </Button>
          ) : null}
        </div>
      </div>
      {root ? (
        <div className="grid min-w-0 gap-3">
          <div
            className={cn(
              "relative mx-auto w-full min-w-0 max-w-md",
              children.has(root.id) &&
                "after:absolute after:top-full after:left-1/2 after:h-3 after:w-px after:bg-border",
            )}
          >
            {node(root, true)}
          </div>
          {branches(root, true)}
        </div>
      ) : null}
      {peers.length ? (
        <div className="mt-4 space-y-3 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">Other threads</p>
          {peers.slice(0, branchLimit).map((participant) => (
            <div key={participant.id}>
              {node(participant)}
              {children.has(participant.id) ? (
                <div className="mt-3 ml-3">{branches(participant)}</div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {directConnections.length ? (
        <div className="mt-4 border-t pt-3" aria-label="Connections between agents">
          <p className="mb-2 text-xs font-medium">Agent-to-agent messages</p>
          <div className="space-y-2">
            {directConnections.slice(0, linkLimit).map((connection) => {
              const from = byId.get(connection.from),
                to = byId.get(connection.to);
              return from && to ? (
                <div
                  key={connectionKey(from.id, to.id)}
                  className="rounded-lg border bg-muted/15 p-2"
                >
                  <p className="mb-1 break-words text-xs">
                    {from.label} <span className="text-muted-foreground">↔</span> {to.label}
                  </p>
                  {flow(from, to, false)}
                </div>
              ) : null;
            })}
          </div>
          {directConnections.length > linkLimit ? (
            <Button size="xs" variant="ghost" onClick={() => setLinkLimit((count) => count + 6)}>
              Show {Math.min(6, directConnections.length - linkLimit)} older connections
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 text-2xs text-muted-foreground">
          No direct messages between separate agents are recorded in the loaded history.
        </p>
      )}
    </div>
  );
}

function messageCount(messages: ReadonlyArray<CommunicationMessage>): string {
  if (!messages.length) return "No messages loaded";
  const kind = messages.every((message) => message.kind === "delegation")
    ? "task"
    : messages.every((message) => message.kind === "response")
      ? "reply"
      : "message";
  const label = messages.length === 1 ? kind : kind === "reply" ? "replies" : `${kind}s`;
  return `${messages.length} ${label}`;
}
